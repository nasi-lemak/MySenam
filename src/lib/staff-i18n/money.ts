// Staff dashboard phrases for this area: English, and the same keys in Malay
// and Chinese (lib/staff-i18n/index.ts). Keys start with the area's prefix.
// Money hardening (`m68.`; ADR 0068): money handed back at the counter for a pass or a membership, the till's list of payouts,
// the cash-up's "still owed back", and how a hire deposit taken before the method was recorded was held.

const en = {
  // Money handed back at the counter from the owed list: what each kind is called in the day's list of payouts
  "m68.payout.entry": "Entry fee",
  "m68.payout.pass": "Pass refund",
  "m68.payout.membership": "Membership refund",
  // A counter-sold pass or membership cancelled with a refund
  "m68.owed.title": "Refunds of passes and memberships sold at the counter, still to hand back",
  "m68.owed.help":
    "A credit note says the sale was cancelled; it is not money paid. Nothing here has been handed over until you say so: when the customer comes, hand it back the way it was paid, then press the button. It is recorded with your name, and it is in that day's list of money handed back at the counter.",
  "m68.owed.linePass": "{name} · pass {what} · {amount} by {via} · credit note {note}",
  "m68.owed.lineMembership": "{name} · membership {what} · {amount} by {via} · credit note {note}",
  "m68.owed.done": "{amount} handed back to {name}. It is recorded, with your name.",
  // A hire deposit taken before its method was recorded
  "m68.act.hireMethodStated": "Said how a hire deposit taken before the method was recorded was held",
  "m68.hire.legacy": "This deposit was taken before the method was recorded. How was it held?",
  "m68.hire.save": "Record it",
  "m68.hire.saved": "Recorded: the deposit was held by {method}. It is counted under that from now on, and the note that it was not recorded when taken stays.",
  "m68.hire.statedBy": "Not recorded when it was taken. Held by {method}, as {by} said on {when}.",
  "m68.hire.failed": "Could not record it",
} as const;

const ms: Record<keyof typeof en, string> = {
  "m68.payout.entry": "Yuran penyertaan",
  "m68.payout.pass": "Bayaran balik pas",
  "m68.payout.membership": "Bayaran balik keahlian",
  "m68.owed.title": "Bayaran balik pas dan keahlian yang dijual di kaunter, masih perlu dipulangkan",
  "m68.owed.help":
    "Nota kredit hanya menyatakan jualan dibatalkan; ia bukan wang yang telah dibayar. Tiada apa-apa di sini dianggap telah diserahkan sehingga anda menyatakannya: apabila pelanggan datang, pulangkan mengikut cara ia dibayar, kemudian tekan butang. Ia direkodkan dengan nama anda, dan dimasukkan dalam senarai wang yang dipulangkan di kaunter pada hari itu.",
  "m68.owed.linePass": "{name} · pas {what} · {amount} melalui {via} · nota kredit {note}",
  "m68.owed.lineMembership": "{name} · keahlian {what} · {amount} melalui {via} · nota kredit {note}",
  "m68.owed.done": "{amount} dipulangkan kepada {name}. Ia direkodkan, dengan nama anda.",
  "m68.act.hireMethodStated": "Menyatakan cara deposit sewa yang diambil sebelum kaedahnya direkodkan dipegang",
  "m68.hire.legacy": "Deposit ini diambil sebelum kaedahnya direkodkan. Bagaimana ia dipegang?",
  "m68.hire.save": "Rekodkan",
  "m68.hire.saved": "Direkodkan: deposit dipegang secara {method}. Ia dikira di bawah kaedah itu mulai sekarang, dan catatan bahawa ia tidak direkodkan semasa diambil kekal.",
  "m68.hire.statedBy": "Tidak direkodkan semasa diambil. Dipegang secara {method}, seperti dinyatakan oleh {by} pada {when}.",
  "m68.hire.failed": "Tidak dapat direkodkan",
};

const zh: Record<keyof typeof en, string> = {
  "m68.payout.entry": "报名费",
  "m68.payout.pass": "次卡退款",
  "m68.payout.membership": "会员退款",
  "m68.owed.title": "在柜台出售的次卡和会员，待退还的款项",
  "m68.owed.help":
    "贷项通知单只说明这笔销售已取消，并不表示款项已付出。在您确认之前，这里的款项都视为尚未交还：顾客前来时，请按原支付方式退还，然后按下按钮。系统会记录您的姓名，并计入当天在柜台退还款项的清单。",
  "m68.owed.linePass": "{name} · 次卡 {what} · {amount}（{via}）· 贷项通知单 {note}",
  "m68.owed.lineMembership": "{name} · 会员 {what} · {amount}（{via}）· 贷项通知单 {note}",
  "m68.owed.done": "已向{name}退还{amount}。系统已记录，并附上您的姓名。",
  "m68.act.hireMethodStated": "说明了在记录方式之前收取的租借押金是如何代管的",
  "m68.hire.legacy": "这笔押金是在系统开始记录代管方式之前收取的。它是以什么方式代管的？",
  "m68.hire.save": "记录",
  "m68.hire.saved": "已记录：押金以{method}方式代管。今后按此方式计算，“收取时未记录”的标记仍会保留。",
  "m68.hire.statedBy": "收取时未记录。{by}于{when}说明以{method}方式代管。",
  "m68.hire.failed": "无法记录",
};

const area = { en, ms, zh };
export default area;
