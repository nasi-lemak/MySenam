// Staff dashboard phrases for contextual help and the discovery view of the
// venue guide (docs/features/venue-guide.md): English, and the same keys in
// Malay and Chinese (lib/staff-i18n/index.ts). Prefix `gh.`. This file is
// contextual help's alone: its explanations and the discovery view's own
// text go here. What the guide's shell, refusals, readiness, discoveries'
// reasons and log entries say is in guide.ts (`gd.`); the explanations a tip
// shows are the playbook's own topics (`gp.t.`, guide-playbook.ts).
//
// English is written first and is authoritative; Malay and Chinese are
// machine-assisted and await review by native speakers, like the rest of the
// dashboard's.

const en = {
  "gh.discoverHeading": "Discover what else MySenam can do",

  // ---- the "?" beside a control: what it is called and what it says
  "gh.tip.name": "Help: {question}",
  "gh.tip.close": "Close",
  "gh.tip.loading": "Loading the help…",
  "gh.tip.failed": "The help could not be loaded.",
  "gh.tip.basis": "Written from this venue's saved settings.",
  "gh.tip.openGuide": "Open this in the guide",

  // ---- the question each "?" answers (one per place: lib/guide/help.ts)
  "gh.q.buffers": "How do booking buffers work?",
  "gh.q.shared": "How do shared and linked facilities work?",
  "gh.q.unattended": "How does unattended access work?",
  "gh.q.peak": "How do peak and off-peak prices work?",
  "gh.q.dated": "How do prices from a later date work?",
  "gh.q.discounts": "How do discounts, concessions and promo codes go together?",
  "gh.q.plans": "What does a membership do: booking privileges or taking part?",
  "gh.q.covers": "What does a membership cover?",
  "gh.q.passes": "How do passes work?",
  "gh.q.guardians": "How do guardians and approvals work?",
  "gh.q.refunds": "Who refunds what when a booking is cancelled?",
  "gh.q.cannot": "Why can't this customer reserve this?",
  "gh.q.coach": "How do I assign another coach?",
  "gh.q.tests": "What are test bookings?",

  // ---- the discover view
  "gh.disc.intro":
    "Things MySenam can do that this venue does not use yet. These are suggestions from simple rules about your settings and your answers: nothing is switched on for you, and one you set aside is not offered again.",
  "gh.disc.suggestions": "Suggestions ({n})",
  "gh.disc.setUp": "Set this up",
  "gh.disc.notForUs": "Not for us",
  "gh.disc.how": "How it works",
  "gh.disc.needs": "Needs {services}.",
  "gh.disc.instead": "Instead: {text}",
  "gh.disc.limit": "Limitation: {text}",
  "gh.disc.working": "Saving…",

  // ---- everything MySenam can do
  "gh.catalog.heading": "Everything MySenam can do",
  "gh.catalog.intro":
    "Every capability MySenam has, by area, and what each one needs. Those marked not currently supported are listed so you know what to do instead; they cannot be set up here.",
  "gh.catalog.counts": "{inUse} in use, {available} available, {unsupported} not currently supported",
  "gh.catalog.suggested": "Suggested above",
  "gh.state.inUse": "In use",
  "gh.state.available": "Available",

  // ---- what a capability needs: the guide's five words
  "gh.avail.now": "Available now",
  "gh.avail.configuration": "Available with configuration",
  "gh.avail.integration": "Requires an external integration",
  "gh.avail.approval": "Requires the operator's approval",
  "gh.avail.unsupported": "Not currently supported",

  // ---- the outside services a capability depends on
  "gh.integ.billplz": "Billplz",
  "gh.integ.stripe": "Stripe",
  "gh.integ.email": "an email service",
  "gh.integ.whatsapp": "WhatsApp",
  "gh.integ.myinvois": "MyInvois",

  // ---- the areas of the catalogue
  "gh.group.booking": "Booking",
  "gh.group.pricing": "Prices and discounts",
  "gh.group.memberships": "Memberships, passes and credit",
  "gh.group.programmes": "Classes, coaching and competitions",
  "gh.group.access": "Access and safety",
  "gh.group.people": "People and staff",
  "gh.group.money": "Payments and refunds",
  "gh.group.communication": "Messages",
  "gh.group.compliance": "Tax and compliance",
  "gh.group.multi-branch": "Branches and going live",
  "gh.group.reporting": "Reports and exports",
  "gh.group.integrations": "Connections to other services",
  "gh.group.platform": "Languages and the app",
};

const ms: Record<keyof typeof en, string> = {
  "gh.discoverHeading": "Terokai apa lagi yang MySenam boleh lakukan",

  "gh.tip.name": "Bantuan: {question}",
  "gh.tip.close": "Tutup",
  "gh.tip.loading": "Memuatkan bantuan…",
  "gh.tip.failed": "Bantuan tidak dapat dimuatkan.",
  "gh.tip.basis": "Ditulis daripada tetapan tersimpan pusat ini.",
  "gh.tip.openGuide": "Buka ini dalam panduan",

  "gh.q.buffers": "Bagaimana penampan tempahan berfungsi?",
  "gh.q.shared": "Bagaimana kemudahan berkongsi dan berpaut berfungsi?",
  "gh.q.unattended": "Bagaimana akses tanpa pengawasan berfungsi?",
  "gh.q.peak": "Bagaimana harga waktu puncak dan bukan puncak berfungsi?",
  "gh.q.dated": "Bagaimana harga dari tarikh kemudian berfungsi?",
  "gh.q.discounts": "Bagaimana diskaun, konsesi dan kod promosi berfungsi bersama?",
  "gh.q.plans": "Apakah yang dilakukan keahlian: keistimewaan tempahan atau penyertaan?",
  "gh.q.covers": "Apakah yang dilindungi oleh keahlian?",
  "gh.q.passes": "Bagaimana pas berfungsi?",
  "gh.q.guardians": "Bagaimana penjaga dan kelulusan berfungsi?",
  "gh.q.refunds": "Siapa yang membayar balik apa apabila tempahan dibatalkan?",
  "gh.q.cannot": "Mengapa pelanggan ini tidak boleh menempah ini?",
  "gh.q.coach": "Bagaimana saya menugaskan jurulatih lain?",
  "gh.q.tests": "Apakah tempahan ujian?",

  "gh.disc.intro":
    "Perkara yang MySenam boleh lakukan tetapi belum digunakan oleh pusat ini. Ini cadangan daripada peraturan mudah tentang tetapan dan jawapan anda: tiada apa-apa dihidupkan untuk anda, dan cadangan yang diketepikan tidak ditawarkan lagi.",
  "gh.disc.suggestions": "Cadangan ({n})",
  "gh.disc.setUp": "Sediakan ini",
  "gh.disc.notForUs": "Bukan untuk kami",
  "gh.disc.how": "Cara ia berfungsi",
  "gh.disc.needs": "Memerlukan {services}.",
  "gh.disc.instead": "Sebaliknya: {text}",
  "gh.disc.limit": "Had: {text}",
  "gh.disc.working": "Menyimpan…",

  "gh.catalog.heading": "Semua yang MySenam boleh lakukan",
  "gh.catalog.intro":
    "Setiap keupayaan MySenam, mengikut bidang, dan apa yang diperlukan oleh setiap satu. Yang ditandai belum disokong disenaraikan supaya anda tahu apa yang perlu dilakukan sebaliknya; ia tidak boleh disediakan di sini.",
  "gh.catalog.counts": "{inUse} digunakan, {available} tersedia, {unsupported} belum disokong",
  "gh.catalog.suggested": "Dicadangkan di atas",
  "gh.state.inUse": "Digunakan",
  "gh.state.available": "Tersedia",

  "gh.avail.now": "Tersedia sekarang",
  "gh.avail.configuration": "Tersedia dengan konfigurasi",
  "gh.avail.integration": "Memerlukan integrasi luaran",
  "gh.avail.approval": "Memerlukan kelulusan pengendali",
  "gh.avail.unsupported": "Belum disokong",

  "gh.integ.billplz": "Billplz",
  "gh.integ.stripe": "Stripe",
  "gh.integ.email": "perkhidmatan e-mel",
  "gh.integ.whatsapp": "WhatsApp",
  "gh.integ.myinvois": "MyInvois",

  "gh.group.booking": "Tempahan",
  "gh.group.pricing": "Harga dan diskaun",
  "gh.group.memberships": "Keahlian, pas dan kredit",
  "gh.group.programmes": "Kelas, bimbingan dan pertandingan",
  "gh.group.access": "Akses dan keselamatan",
  "gh.group.people": "Orang dan kakitangan",
  "gh.group.money": "Pembayaran dan bayaran balik",
  "gh.group.communication": "Mesej",
  "gh.group.compliance": "Cukai dan pematuhan",
  "gh.group.multi-branch": "Cawangan dan mula beroperasi",
  "gh.group.reporting": "Laporan dan eksport",
  "gh.group.integrations": "Sambungan ke perkhidmatan lain",
  "gh.group.platform": "Bahasa dan aplikasi",
};

const zh: Record<keyof typeof en, string> = {
  "gh.discoverHeading": "发现 MySenam 还能做什么",

  "gh.tip.name": "帮助：{question}",
  "gh.tip.close": "关闭",
  "gh.tip.loading": "正在加载帮助…",
  "gh.tip.failed": "无法加载帮助内容。",
  "gh.tip.basis": "根据本场馆已保存的设置编写。",
  "gh.tip.openGuide": "在指南中打开",

  "gh.q.buffers": "预订缓冲时间是如何运作的？",
  "gh.q.shared": "共享和关联设施是如何运作的？",
  "gh.q.unattended": "无人值守入场是如何运作的？",
  "gh.q.peak": "高峰与非高峰价格是如何运作的？",
  "gh.q.dated": "从之后某日起生效的价格是如何运作的？",
  "gh.q.discounts": "折扣、优惠价和促销码是如何配合的？",
  "gh.q.plans": "会员资格有什么作用：预订特权还是参与资格？",
  "gh.q.covers": "会员资格涵盖什么？",
  "gh.q.passes": "次卡是如何运作的？",
  "gh.q.guardians": "监护人和审批是如何运作的？",
  "gh.q.refunds": "取消预订时，谁来退什么？",
  "gh.q.cannot": "为什么这位顾客无法预订这个？",
  "gh.q.coach": "如何指派另一位教练？",
  "gh.q.tests": "什么是测试预订？",

  "gh.disc.intro":
    "MySenam 能做、但本场馆尚未使用的功能。这些建议来自对您的设置和回答所做的简单规则判断：不会替您开启任何功能，您搁置的建议也不会再次出现。",
  "gh.disc.suggestions": "建议（{n}）",
  "gh.disc.setUp": "开始设置",
  "gh.disc.notForUs": "不适合我们",
  "gh.disc.how": "它如何运作",
  "gh.disc.needs": "需要{services}。",
  "gh.disc.instead": "替代方案：{text}",
  "gh.disc.limit": "限制：{text}",
  "gh.disc.working": "正在保存…",

  "gh.catalog.heading": "MySenam 的全部功能",
  "gh.catalog.intro": "MySenam 具备的所有功能，按领域列出，并说明各自需要什么。标为暂不支持的功能列出来是为了让您知道可以怎么做；它们无法在这里设置。",
  "gh.catalog.counts": "使用中 {inUse} 项，可用 {available} 项，暂不支持 {unsupported} 项",
  "gh.catalog.suggested": "已在上方建议",
  "gh.state.inUse": "使用中",
  "gh.state.available": "可用",

  "gh.avail.now": "现在可用",
  "gh.avail.configuration": "配置后可用",
  "gh.avail.integration": "需要外部集成",
  "gh.avail.approval": "需要运营方批准",
  "gh.avail.unsupported": "暂不支持",

  "gh.integ.billplz": "Billplz",
  "gh.integ.stripe": "Stripe",
  "gh.integ.email": "电子邮件服务",
  "gh.integ.whatsapp": "WhatsApp",
  "gh.integ.myinvois": "MyInvois",

  "gh.group.booking": "预订",
  "gh.group.pricing": "价格与折扣",
  "gh.group.memberships": "会员、次卡与储值",
  "gh.group.programmes": "课程、教练与赛事",
  "gh.group.access": "入场与安全",
  "gh.group.people": "人员与员工",
  "gh.group.money": "付款与退款",
  "gh.group.communication": "消息通知",
  "gh.group.compliance": "税务与合规",
  "gh.group.multi-branch": "分店与正式上线",
  "gh.group.reporting": "报表与导出",
  "gh.group.integrations": "与其他服务的连接",
  "gh.group.platform": "语言与应用",
};

const area = { en, ms, zh };
export default area;
