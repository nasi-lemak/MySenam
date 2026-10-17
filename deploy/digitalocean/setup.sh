#!/usr/bin/env bash
#
# Turn a fresh Ubuntu 24.04 Droplet into a MySenam server: Postgres, Node 22,
# Caddy in front, a firewall, security updates on their own, and a systemd
# service for the app. Copy this folder to the Droplet and run it once, as
# root:
#
#   scp -r deploy/digitalocean root@<droplet>:mysenam-kit
#   ssh root@<droplet> bash mysenam-kit/setup.sh --domain book.example.my \
#       --email you@example.my --repo git@github.com:<owner>/<repo>.git --branch main
#
# Safe to run again: it never replaces a password, key or setting it already
# made. What it writes:
#
#   /etc/mysenam/env         the app's settings and secrets (root:mysenam 0640)
#   /etc/mysenam/deploy.conf where deploy.sh fetches the code from
#   /srv/mysenam             releases/, current -> the live one
#   /var/lib/mysenam         the data folder: backups
#
# Then: add the deploy key it prints to GitHub, fill in ADMIN_EMAIL and
# ADMIN_PASSWORD in /etc/mysenam/env, and run deploy.sh.
set -euo pipefail

DOMAIN="" EMAIL="" REPO="" BRANCH="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$DOMAIN" || -z "$EMAIL" || -z "$REPO" ]]; then
  echo "Usage: bash setup.sh --domain book.example.my --email you@example.my --repo git@github.com:owner/repo.git [--branch main]" >&2
  exit 1
fi
[[ $EUID -eq 0 ]] || { echo "Run this as root." >&2; exit 1; }
. /etc/os-release
[[ "$ID" == "ubuntu" && "$VERSION_ID" == "24.04" ]] || echo "Warning: written for Ubuntu 24.04; this is $PRETTY_NAME." >&2

step() { printf '\n== %s\n' "$*"; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in Caddyfile mysenam.service postgresql.conf deploy.sh run.sh; do
  [[ -f "$here/$f" ]] || { echo "$f is missing: run this from the whole deploy/digitalocean folder." >&2; exit 1; }
done

export DEBIAN_FRONTEND=noninteractive

step "Swap"
# A 2 GB Droplet has no swap. `next build` briefly wants more than the app
# does, and a little swap turns a would-be out-of-memory kill into a slow
# minute instead.
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-mysenam-swap.conf
fi

step "Packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg git ufw unattended-upgrades \
  postgresql postgresql-contrib build-essential python3 debian-keyring debian-archive-keyring apt-transport-https

step "Node.js 22"
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
node --version

step "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

step "Security updates, applied on their own"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

step "Firewall: SSH, HTTP and HTTPS only"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status | head -n 12

step "The mysenam user and its folders"
id mysenam >/dev/null 2>&1 || useradd --system --home-dir /srv/mysenam --create-home --shell /bin/bash mysenam
install -d -o mysenam -g mysenam -m 750 /srv/mysenam /srv/mysenam/releases /var/lib/mysenam /var/lib/mysenam/backups
install -d -o root -g mysenam -m 750 /etc/mysenam

step "Deploy key"
if [[ ! -f /srv/mysenam/.ssh/id_ed25519 ]]; then
  install -d -o mysenam -g mysenam -m 700 /srv/mysenam/.ssh
  runuser -u mysenam -- ssh-keygen -q -t ed25519 -N '' -C "mysenam@$(hostname)" -f /srv/mysenam/.ssh/id_ed25519
  runuser -u mysenam -- bash -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null'
fi

step "Postgres"
PGCONF_DIR="$(ls -d /etc/postgresql/*/main | sort -V | tail -1)/conf.d"
mkdir -p "$PGCONF_DIR"
cp "$here/postgresql.conf" "$PGCONF_DIR/mysenam.conf"
systemctl restart postgresql
if [[ ! -f /etc/mysenam/env ]]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'mysenam'" | grep -q 1; then
    runuser -u postgres -- psql -qc "ALTER ROLE mysenam WITH LOGIN PASSWORD '$DB_PASSWORD'"
  else
    runuser -u postgres -- psql -qc "CREATE ROLE mysenam WITH LOGIN PASSWORD '$DB_PASSWORD'"
  fi
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'mysenam'" | grep -q 1 \
    || runuser -u postgres -- createdb -O mysenam mysenam

  step "Settings: /etc/mysenam/env"
  umask 027
  cat > /etc/mysenam/env <<EOF
# MySenam's settings. Change one, then: systemctl restart mysenam
NODE_ENV=production
MYSENAM_URL=https://$DOMAIN
DATABASE_URL=postgres://mysenam:$DB_PASSWORD@127.0.0.1:5432/mysenam
MYSENAM_DATA_DIR=/var/lib/mysenam
# Unlocks the payment keys and other secrets saved in the database. Keep a
# copy somewhere safe: a backup restored without it cannot open them.
MYSENAM_SECRET=$(openssl rand -hex 32)

# The first operator account. Set both before the first start.
ADMIN_EMAIL=
ADMIN_PASSWORD=

# SITE_NAME=Arena Sports Booking
# MYSENAM_MARKETPLACE=on

# Off-site backups — Cloudflare R2, Backblaze B2 or S3. Without these every
# backup sits on the same disk as the database it is a backup of.
# OFFSITE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
# OFFSITE_S3_BUCKET=
# OFFSITE_S3_ACCESS_KEY_ID=
# OFFSITE_S3_SECRET_ACCESS_KEY=

# Messages to customers.
# WHATSAPP_TOKEN=
# WHATSAPP_PHONE_NUMBER_ID=
# SMTP_URL=smtp://user:password@smtp.example.com:587
# MAIL_FROM=Arena <bookings@example.my>
EOF
  chown root:mysenam /etc/mysenam/env
  chmod 640 /etc/mysenam/env
fi

cat > /etc/mysenam/deploy.conf <<EOF
REPO=$REPO
BRANCH=$BRANCH
EOF

step "The service"
cp "$here/mysenam.service" /etc/systemd/system/mysenam.service
systemctl daemon-reload
systemctl enable mysenam >/dev/null

step "Caddy's configuration"
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__ACME_EMAIL__|$EMAIL|g" "$here/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

install -m 750 "$here/deploy.sh" /usr/local/sbin/mysenam-deploy
install -m 750 "$here/run.sh" /usr/local/sbin/mysenam-run

cat <<EOF

Done. Three things left:

1. Add this key to the repository on GitHub as a read-only deploy key
   (Settings → Deploy keys → Add deploy key):

$(cat /srv/mysenam/.ssh/id_ed25519.pub)

2. Point $DOMAIN at this server: an A record for $(curl -fsS4 https://ifconfig.co 2>/dev/null || echo "this Droplet's address").

3. Set ADMIN_EMAIL and ADMIN_PASSWORD in /etc/mysenam/env, then deploy:

   mysenam-deploy
EOF
