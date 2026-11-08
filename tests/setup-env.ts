import { scrubProviderEnv } from "./hermetic-env";

scrubProviderEnv();

// How full the machine's own disk is must not decide whether a suite passes (lib/disk-health.ts): the thresholds sit where only an
// all but full disk reaches them. The disk tests set their own thresholds and stub the volume's answer.
process.env.MYSENAM_DISK_WARN_PERCENT ??= "98";
process.env.MYSENAM_DISK_CRITICAL_PERCENT ??= "99";
process.env.MYSENAM_DISK_BLOCK_PERCENT ??= "100";
