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
  // A customer's cancellation of a booking paid at the counter (ADR 0074): the obligation on the list of money owed back at the counter
  "rf74.owed.cause.customer": "the customer cancelled it",
  "rf74.owed.cause.place": "the customer took a person off it",
  "rf74.owed.arose": "Arose {date}",
  "rf74.owed.status": "Owed: not handed back yet",
  "rf74.owed.action": "To do: hand back {amount} ({via}) when the customer comes, then press the button. A credit note is not money paid.",
  "rf74.owed.note": "Credit note {note}",
  "rf74.owed.told": "Customer told on {date}",
  "rf74.owed.notToldEmail": "Customer not told yet: tell them at the counter",
  "rf74.owed.notToldNoEmail": "No email address: tell the customer the venue will return it at the counter",
  "rf74.owed.viaLabel": "Hand back by",
  "rf74.owed.viaAsPaid": "As paid ({via})",
  "rf74.owed.viaAsPaidNone": "As paid (method not recorded)",
  "rf74.owed.doneVia": "{amount} handed back for {code}, by {via}, not the way it was paid: it is recorded with your name.",
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
  "rf74.owed.cause.customer": "pelanggan membatalkannya",
  "rf74.owed.cause.place": "pelanggan mengeluarkan seorang daripadanya",
  "rf74.owed.arose": "Timbul pada {date}",
  "rf74.owed.status": "Terhutang: belum dipulangkan",
  "rf74.owed.action": "Perlu dibuat: pulangkan {amount} ({via}) apabila pelanggan datang, kemudian tekan butang. Nota kredit bukan wang yang telah dibayar.",
  "rf74.owed.note": "Nota kredit {note}",
  "rf74.owed.told": "Pelanggan dimaklumkan pada {date}",
  "rf74.owed.notToldEmail": "Pelanggan belum dimaklumkan: beritahu mereka di kaunter",
  "rf74.owed.notToldNoEmail": "Tiada alamat e-mel: beritahu pelanggan bahawa pusat akan memulangkannya di kaunter",
  "rf74.owed.viaLabel": "Pulangkan melalui",
  "rf74.owed.viaAsPaid": "Seperti dibayar ({via})",
  "rf74.owed.viaAsPaidNone": "Seperti dibayar (kaedah tidak direkodkan)",
  "rf74.owed.doneVia": "{amount} dipulangkan untuk {code}, melalui {via}, bukan cara ia dibayar: ia direkodkan dengan nama anda.",
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
  "rf74.owed.cause.customer": "顾客取消了预订",
  "rf74.owed.cause.place": "顾客取消了其中一人的名额",
  "rf74.owed.arose": "产生于 {date}",
  "rf74.owed.status": "待退还：尚未交还",
  "rf74.owed.action": "待办：顾客前来时退还 {amount}（{via}），然后按下按钮。贷项通知单不代表款项已付出。",
  "rf74.owed.note": "贷项通知单 {note}",
  "rf74.owed.told": "已于 {date} 通知顾客",
  "rf74.owed.notToldEmail": "尚未通知顾客：请在柜台告知",
  "rf74.owed.notToldNoEmail": "没有电子邮件地址：请告知顾客场馆会在柜台退还",
  "rf74.owed.viaLabel": "退还方式",
  "rf74.owed.viaAsPaid": "按原支付方式（{via}）",
  "rf74.owed.viaAsPaidNone": "按原支付方式（方式未记录）",
  "rf74.owed.doneVia": "已以{via}退还 {code} 的 {amount}，并非按原支付方式：系统已记录，并附上您的姓名。",
};

const area = { en, ms, zh };
export default area;
