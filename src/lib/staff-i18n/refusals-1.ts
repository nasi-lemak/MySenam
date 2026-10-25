// Refusals the server sends in English (route handlers and lib/*), in Malay and
// Chinese, keyed by the English sentence exactly as sent. In a pattern, {0},
// {1}… stand for the values the server filled in, in order; the translation
// uses the same numbers. Read by `t.err` (index.ts).

export const REFUSALS: Record<string, { ms: string; zh: string }> = {
  "'from' must not be after 'to'.": {
    ms: "'from' tidak boleh selepas 'to'.",
    zh: "'from' 不能晚于 'to'。",
  },
  "A TIN is a letter or two and then digits, like C1234567890.": {
    ms: "TIN ialah satu atau dua huruf diikuti digit, contohnya C1234567890.",
    zh: "TIN 由一至两个字母加数字组成，例如 C1234567890。",
  },
  "A booking can only move within the same venue.": {
    ms: "Tempahan hanya boleh dipindah dalam pusat yang sama.",
    zh: "预订只能在同一场馆内调整。",
  },
  "A booking of several courts is for one date, without extras or a coach.": {
    ms: "Tempahan beberapa gelanggang adalah untuk satu tarikh, tanpa tambahan atau jurulatih.",
    zh: "多场地预订仅限同一日期，且不含附加项目或教练。",
  },
  "A box holds 3 to 6.": {
    ms: "Satu kotak memuatkan 3 hingga 6 pemain.",
    zh: "每组 3 至 6 人。",
  },
  "A box is 1 or more.": {
    ms: "Nombor kotak mestilah 1 atau lebih.",
    zh: "组号须为 1 或以上。",
  },
  "A built-in activity is changed in the code; it can only be offered or not.": {
    ms: "Aktiviti terbina dalam diubah dalam kod; ia hanya boleh ditawarkan atau tidak.",
    zh: "内置活动只能在代码中修改；这里只能选择是否提供。",
  },
  "A business needs at least one manager.": {
    ms: "Perniagaan memerlukan sekurang-kurangnya seorang pengurus.",
    zh: "企业至少需要一名经理。",
  },
  "A certification needs what was seen (its number and issuer) and the day it runs out.": {
    ms: "Pensijilan memerlukan butiran yang dilihat (nombor dan pengeluarnya) serta tarikh tamat tempohnya.",
    zh: "证书须填写所核实的内容（证书编号和签发机构）以及到期日。",
  },
  "A class enrolment moves with its class, not on its own.": {
    ms: "Pendaftaran kelas berpindah bersama kelasnya, bukan secara berasingan.",
    zh: "课程报名随课程一起调整，不能单独调整。",
  },
  "A class place cannot be shared.": {
    ms: "Tempat dalam kelas tidak boleh dikongsi.",
    zh: "课程名额不能共享。",
  },
  "A code is 3–20 letters, digits or dashes.": {
    ms: "Kod mestilah 3–20 huruf, digit atau sempang.",
    zh: "代码须为 3–20 个字母、数字或连字符。",
  },
  "A correction of the record only cannot take anybody out of the event; withdraw them instead.": {
    ms: "Pembetulan rekod sahaja tidak boleh mengeluarkan sesiapa daripada acara; tarik diri mereka sebagai ganti.",
    zh: "仅更正记录不能将任何人移出赛事；请改为办理退赛。",
  },
  "A court booked whole already has one price for the booking.": {
    ms: "Gelanggang yang ditempah sepenuhnya sudah mempunyai satu harga bagi setiap tempahan.",
    zh: "整场预订的场地本来就是每笔预订一个价格。",
  },
  "A court cannot take itself.": {
    ms: "Gelanggang tidak boleh merangkumi dirinya sendiri.",
    zh: "场地不能包含它自己。",
  },
  "A court offers up to 12 activities.": {
    ms: "Satu gelanggang boleh menawarkan sehingga 12 aktiviti.",
    zh: "每个场地最多提供 12 项活动。",
  },
  "A deposit cannot be negative.": {
    ms: "Deposit tidak boleh negatif.",
    zh: "押金不能为负数。",
  },
  "A discount above zero is required.": {
    ms: "Diskaun melebihi sifar diperlukan.",
    zh: "优惠须大于零。",
  },
  "A division has finished: call off the others one by one.": {
    ms: "Satu bahagian telah selesai: batalkan bahagian lain satu demi satu.",
    zh: "已有组别结束：请逐个取消其他组别。",
  },
  "A division's draw is made: add divisions before any draw.": {
    ms: "Undian sesuatu bahagian telah dibuat: tambah bahagian sebelum sebarang undian.",
    zh: "已有组别完成抽签：须在任何抽签之前添加组别。",
  },
  "A domain and a name are required.": {
    ms: "Domain dan nama diperlukan.",
    zh: "须填写域名和名称。",
  },
  "A door code can only use letters, digits, #, * and -.": {
    ms: "Kod pintu hanya boleh mengandungi huruf, digit, #, * dan -.",
    zh: "门禁码只能使用字母、数字、#、* 和 -。",
  },
  "A friend has paid already, so the split stays as it is.": {
    ms: "Seorang rakan telah membayar, jadi pembahagian kekal seperti sedia ada.",
    zh: "已有朋友付款，因此分摊方式保持不变。",
  },
  "A group holds 2 to 60 people.": {
    ms: "Kumpulan memuatkan 2 hingga 60 orang.",
    zh: "群组可容纳 2 至 60 人。",
  },
  "A guest needs an end date.": {
    ms: "Tetamu memerlukan tarikh tamat.",
    zh: "访客须设定结束日期。",
  },
  "A heat's results are each competitor's marks.": {
    ms: "Keputusan saringan ialah markah setiap peserta.",
    zh: "预赛结果为每位参赛者的成绩。",
  },
  "A holder name and phone number are required.": {
    ms: "Nama dan nombor telefon pemegang diperlukan.",
    zh: "须填写持有人姓名和电话号码。",
  },
  "A knockout, groups then a knockout, a round robin, or a performance event.": {
    ms: "Kalah mati, kumpulan kemudian kalah mati, round robin, atau acara prestasi.",
    zh: "淘汰赛、小组赛加淘汰赛、循环赛或成绩赛。",
  },
  "A league's matches are head to head.": {
    ms: "Perlawanan liga adalah antara dua pihak.",
    zh: "联赛比赛为两方对决。",
  },
  "A league's matches are head to head: choose a template scored in sets or a tally.": {
    ms: "Perlawanan liga adalah antara dua pihak: pilih templat yang dikira mengikut set atau jumlah kiraan.",
    zh: "联赛比赛为两方对决：请选择按局计分或累计计分的模板。",
  },
  "A limit must be an amount, or blank for none.": {
    ms: "Had mestilah satu jumlah, atau kosongkan jika tiada had.",
    zh: "限额须为金额，留空表示不设限额。",
  },
  "A limit per customer must be a whole number above zero.": {
    ms: "Had setiap pelanggan mestilah nombor bulat melebihi sifar.",
    zh: "每位顾客的限额须为大于零的整数。",
  },
  "A link goes to a page on this site, like /tournaments/12.": {
    ms: "Pautan mesti ke halaman di laman ini, contohnya /tournaments/12.",
    zh: "链接须指向本网站的页面，例如 /tournaments/12。",
  },
  "A manager or front desk.": {
    ms: "Pengurus atau kaunter hadapan.",
    zh: "经理或前台。",
  },
  "A match is the best of 1, 3, 5 or 7 sets.": {
    ms: "Perlawanan ialah terbaik daripada 1, 3, 5 atau 7 set.",
    zh: "每场比赛采用 1、3、5 或 7 局制。",
  },
  "A member rate cannot be negative.": {
    ms: "Kadar ahli tidak boleh negatif.",
    zh: "会员价不能为负数。",
  },
  "A name is on the roster twice.": {
    ms: "Satu nama tersenarai dua kali dalam senarai pemain.",
    zh: "名单上有重复的名字。",
  },
  "A paid invoice stays.": {
    ms: "Invois yang telah dibayar kekal dan tidak boleh dibuang.",
    zh: "已付款的发票须保留，不能删除。",
  },
  "A pass pays for court time only. Pay for a booking with extras another way.": {
    ms: "Pas hanya membayar masa gelanggang. Bayar tempahan yang ada tambahan dengan cara lain.",
    zh: "次卡只能支付场地时间。含附加项目的预订请用其他方式付款。",
  },
  "A pass spends entries or court time.": {
    ms: "Pas menggunakan kemasukan atau masa gelanggang.",
    zh: "次卡按次数或场地时间扣除。",
  },
  "A performance event needs what is measured: choose a performance template.": {
    ms: "Acara prestasi memerlukan apa yang diukur: pilih templat prestasi.",
    zh: "成绩赛须指定衡量项目：请选择成绩赛模板。",
  },
  "A performance event takes players one by one.": {
    ms: "Acara prestasi menerima pemain secara individu.",
    zh: "成绩赛只接受个人报名。",
  },
  "A performance event's marks are entered by staff.": {
    ms: "Markah acara prestasi dimasukkan oleh kakitangan.",
    zh: "成绩赛的成绩由员工录入。",
  },
  "A performance event's rules are a set of choices.": {
    ms: "Peraturan acara prestasi ialah satu set pilihan.",
    zh: "成绩赛的规则须为一组选项。",
  },
  "A phone number is required.": {
    ms: "Nombor telefon diperlukan.",
    zh: "须填写电话号码。",
  },
  "A player may enter 1 to 20 divisions, or leave it open.": {
    ms: "Pemain boleh menyertai 1 hingga 20 bahagian, atau biarkan tanpa had.",
    zh: "每位球员可报名 1 至 20 个组别，或不设限制。",
  },
  "A quantity price is 1% to 99% of the rate.": {
    ms: "Harga kuantiti ialah 1% hingga 99% daripada kadar.",
    zh: "数量价须为原价的 1% 至 99%。",
  },
  "A quantity price starts from 2 to 50.": {
    ms: "Harga kuantiti bermula daripada 2 hingga 50.",
    zh: "数量价的起始数量须为 2 至 50。",
  },
  "A report can cover at most 400 days.": {
    ms: "Laporan boleh merangkumi paling lama 400 hari.",
    zh: "报告最多涵盖 400 天。",
  },
  "A resident, a member or a guest.": {
    ms: "Penduduk, ahli atau tetamu.",
    zh: "住户、会员或访客。",
  },
  "A resource booked whole has one place.": {
    ms: "Sumber yang ditempah sepenuhnya mempunyai satu tempat.",
    zh: "整场预订的资源只有一个名额。",
  },
  "A result, or did not start, did not finish, disqualified.": {
    ms: "Keputusan, atau tidak bermula, tidak tamat, hilang kelayakan.",
    zh: "成绩，或未起赛、未完赛、取消资格。",
  },
  "A roster of 1 to 40 names, the fewest no more than the most.": {
    ms: "Senarai pemain 1 hingga 40 nama, dengan minimum tidak melebihi maksimum.",
    zh: "名单为 1 至 40 人，最少人数不得超过最多人数。",
  },
  "A round robin is for 16 entries at most: make groups instead.": {
    ms: "Round robin untuk paling banyak 16 penyertaan: buat kumpulan sebagai ganti.",
    zh: "循环赛最多 16 个报名：请改为分组。",
  },
  "A season is 1 to 9 weeks.": {
    ms: "Satu musim ialah 1 hingga 9 minggu.",
    zh: "每个赛季为 1 至 9 周。",
  },
  "A season is 2 to 8 weeks.": {
    ms: "Satu musim ialah 2 hingga 8 minggu.",
    zh: "每个赛季为 2 至 8 周。",
  },
  "A seed is 1 or more.": {
    ms: "Nombor pilihan mestilah 1 atau lebih.",
    zh: "种子序号须为 1 或以上。",
  },
  "A sign-off is needed, or not.": {
    ms: "Pilih sama ada pengesahan diperlukan atau tidak.",
    zh: "请选择是否需要资格确认。",
  },
  "A sign-off or a certification.": {
    ms: "Pengesahan atau pensijilan.",
    zh: "资格确认或证书。",
  },
  "A staffed hour must be a whole hour between midnight and the latest close.": {
    ms: "Waktu ada kakitangan mestilah jam penuh antara tengah malam dan waktu tutup paling lewat.",
    zh: "有人值守时间须为午夜至最晚打烊时间之间的整点。",
  },
  "A staffed hour must be between midnight and the latest close.": {
    ms: "Waktu ada kakitangan mestilah antara tengah malam dan waktu tutup paling lewat.",
    zh: "有人值守时间须在午夜至最晚打烊时间之间。",
  },
  "A storefront shows at least one venue.": {
    ms: "Laman web jenama memaparkan sekurang-kurangnya satu pusat.",
    zh: "品牌网站须至少展示一个场馆。",
  },
  "A team of that name has entered already.": {
    ms: "Pasukan dengan nama itu telah menyertai.",
    zh: "已有同名队伍报名。",
  },
  "A third-place match is for a knockout, or groups then a knockout.": {
    ms: "Perlawanan tempat ketiga untuk kalah mati, atau kumpulan kemudian kalah mati.",
    zh: "季军赛仅适用于淘汰赛，或小组赛加淘汰赛。",
  },
  "A usage limit must be a whole number above zero.": {
    ms: "Had penggunaan mestilah nombor bulat melebihi sifar.",
    zh: "使用次数上限须为大于零的整数。",
  },
  "A valid date is required.": {
    ms: "Tarikh yang sah diperlukan.",
    zh: "须填写有效日期。",
  },
  "A valid email is required.": {
    ms: "E-mel yang sah diperlukan.",
    zh: "须填写有效电邮。",
  },
  "A valid sport is required.": {
    ms: "Sukan yang sah diperlukan.",
    zh: "须指定有效的运动项目。",
  },
  "A valid token is required.": {
    ms: "Token yang sah diperlukan.",
    zh: "须提供有效的令牌。",
  },
  "A venue must be open for at least an hour.": {
    ms: "Pusat mesti dibuka sekurang-kurangnya sejam.",
    zh: "场馆每次营业至少一小时。",
  },
  "A walkover or a retirement has a winner.": {
    ms: "Walkover atau tarik diri mesti ada pemenang.",
    zh: "不战而胜或中途退赛须有胜方。",
  },
  "Account not found.": {
    ms: "Akaun tidak dijumpai.",
    zh: "找不到账户。",
  },
  "Activity not found.": {
    ms: "Aktiviti tidak dijumpai.",
    zh: "找不到活动。",
  },
  "Add something to sell.": {
    ms: "Tambah sesuatu untuk dijual.",
    zh: "请添加要出售的商品。",
  },
  "Address not found, or turned off.": {
    ms: "Alamat tidak dijumpai, atau dimatikan.",
    zh: "找不到该地址，或已关闭。",
  },
  "Admin not found.": {
    ms: "Pentadbir tidak dijumpai.",
    zh: "找不到管理员。",
  },
  "Ages are 3 to 99.": {
    ms: "Umur ialah 3 hingga 99.",
    zh: "年龄须为 3 至 99 岁。",
  },
  "Amounts are positive, to the cent.": {
    ms: "Jumlah mestilah positif, hingga ke sen.",
    zh: "金额须为正数，精确到分。",
  },
  "An account with this email already exists.": {
    ms: "Akaun dengan e-mel ini sudah wujud.",
    zh: "此电邮已有账户。",
  },
  "An account with this email already exists. Sign in with your password instead.": {
    ms: "Akaun dengan e-mel ini sudah wujud. Log masuk dengan kata laluan anda.",
    zh: "此电邮已有账户。请改用密码登录。",
  },
  "An admin with this email already exists.": {
    ms: "Pentadbir dengan e-mel ini sudah wujud.",
    zh: "此电邮已有管理员账户。",
  },
  "An email address to send the voucher to is needed.": {
    ms: "Alamat e-mel untuk menghantar baucar diperlukan.",
    zh: "须提供接收礼券的电邮地址。",
  },
  "An exclusive court is blocked whole, not in parts.": {
    ms: "Gelanggang eksklusif disekat sepenuhnya, bukan sebahagian.",
    zh: "专用场地须整场封锁，不能部分封锁。",
  },
  "An organiser closes the group rather than leaving it.": {
    ms: "Penganjur menutup kumpulan dan bukannya keluar daripadanya.",
    zh: "组织者应关闭群组，而不是退出。",
  },
  "An unmanned resource needs a door code. Set one first.": {
    ms: "Sumber tanpa penjaga memerlukan kod pintu. Tetapkan dahulu.",
    zh: "无人值守的资源须设门禁码。请先设置。",
  },
  "Anyone, women only or men only.": {
    ms: "Sesiapa sahaja, wanita sahaja atau lelaki sahaja.",
    zh: "不限、仅限女性或仅限男性。",
  },
  "Anyone, women or men.": {
    ms: "Sesiapa sahaja, wanita atau lelaki.",
    zh: "不限、女性或男性。",
  },
  "Application not found.": {
    ms: "Permohonan tidak dijumpai.",
    zh: "找不到申请。",
  },
  "Ask your business's manager to send the venue to go live.": {
    ms: "Minta pengurus perniagaan anda menghantar pusat ini untuk dilancarkan.",
    zh: "请让贵企业的经理提交场馆上线。",
  },
  "At least 3 players are needed.": {
    ms: "Sekurang-kurangnya 3 pemain diperlukan.",
    zh: "至少需要 3 名球员。",
  },
  "At most 1 to 50 in one booking.": {
    ms: "Maksimum dalam satu tempahan mestilah 1 hingga 50.",
    zh: "每笔预订的上限须为 1 至 50。",
  },
  "At most 20 stretches of time off ahead.": {
    ms: "Paling banyak 20 tempoh cuti akan datang.",
    zh: "最多可设 20 段未来的休假时间。",
  },
  "Bad signature.": {
    ms: "Tandatangan tidak sah.",
    zh: "签名无效。",
  },
  "Between 2 and 128 entries.": {
    ms: "Antara 2 hingga 128 penyertaan.",
    zh: "报名数须为 2 至 128。",
  },
  "Billing starts on a date, YYYY-MM-DD.": {
    ms: "Pengebilan bermula pada tarikh, YYYY-MM-DD.",
    zh: "计费开始日期须为 YYYY-MM-DD 格式。",
  },
  "Bookings at different venues are paid separately.": {
    ms: "Tempahan di pusat berlainan dibayar secara berasingan.",
    zh: "不同场馆的预订须分开付款。",
  },
  "Bookings keep arriving for those days. Try again in a moment.": {
    ms: "Tempahan masih masuk untuk hari-hari itu. Cuba lagi sebentar lagi.",
    zh: "这几天仍有新预订进来。请稍后再试。",
  },
  "Both sides are not known yet.": {
    ms: "Kedua-dua pihak belum diketahui.",
    zh: "双方尚未确定。",
  },
  "Buffers are 0 to 240 minutes.": {
    ms: "Masa penampan ialah 0 hingga 240 minit.",
    zh: "缓冲时间须为 0 至 240 分钟。",
  },
  "Business not found.": {
    ms: "Perniagaan tidak dijumpai.",
    zh: "找不到企业。",
  },
  "Cannot remove the last platform owner.": {
    ms: "Pemilik platform terakhir tidak boleh dibuang.",
    zh: "不能移除最后一位平台所有者。",
  },
  "Capacity must be at least 1.": {
    ms: "Kapasiti mestilah sekurang-kurangnya 1.",
    zh: "容量至少为 1。",
  },
  "Casual, competitive or either.": {
    ms: "Santai, kompetitif atau mana-mana.",
    zh: "休闲、竞技或皆可。",
  },
  "Chat replies are not set up.": {
    ms: "Balasan sembang belum disediakan.",
    zh: "尚未设置聊天回复。",
  },
  "Check the entry fee.": {
    ms: "Semak yuran penyertaan.",
    zh: "请检查报名费。",
  },
  "Check the fee.": {
    ms: "Semak yuran.",
    zh: "请检查费用。",
  },
  "Choose a category.": {
    ms: "Pilih kategori.",
    zh: "请选择类别。",
  },
  "Choose a photo.": {
    ms: "Pilih foto.",
    zh: "请选择照片。",
  },
  "Choose a surface from the list.": {
    ms: "Pilih permukaan daripada senarai.",
    zh: "请从列表中选择场地表面。",
  },
  "Choose at least one sport they coach.": {
    ms: "Pilih sekurang-kurangnya satu sukan yang mereka latih.",
    zh: "请至少选择一项其执教的运动。",
  },
  "Choose at least one venue.": {
    ms: "Pilih sekurang-kurangnya satu pusat.",
    zh: "请至少选择一个场馆。",
  },
  "Choose exactly as many of those level as there are places left in the final.": {
    ms: "Daripada mereka yang terikat sama, pilih tepat seramai tempat yang masih tinggal di final.",
    zh: "请从成绩相同者中选出与决赛剩余名额相同的人数。",
  },
  "Choose facilities from the list.": {
    ms: "Pilih kemudahan daripada senarai.",
    zh: "请从列表中选择设施。",
  },
  "Choose how it is booked.": {
    ms: "Pilih cara ia ditempah.",
    zh: "请选择预订方式。",
  },
  "Choose how money paid online goes back.": {
    ms: "Pilih cara wang yang dibayar dalam talian dipulangkan.",
    zh: "请选择在线付款的退款方式。",
  },
  "Choose public, members only or private.": {
    ms: "Pilih awam, ahli sahaja atau persendirian.",
    zh: "请选择公开、仅限会员或私人。",
  },
  "Choose the courts it is rained off on.": {
    ms: "Pilih gelanggang yang terjejas hujan.",
    zh: "请选择因雨停用的场地。",
  },
  "Choose the courts.": {
    ms: "Pilih gelanggang.",
    zh: "请选择场地。",
  },
  "Choose the days of the week.": {
    ms: "Pilih hari dalam minggu.",
    zh: "请选择星期几。",
  },
  "Choose the state.": {
    ms: "Pilih negeri.",
    zh: "请选择州属。",
  },
  "Choose the venue's state.": {
    ms: "Pilih negeri pusat ini.",
    zh: "请选择场馆所在州属。",
  },
  "Choose what it is called from the list.": {
    ms: "Pilih namanya daripada senarai.",
    zh: "请从列表中选择名称。",
  },
  "Choose what one of its resources is called.": {
    ms: "Pilih panggilan bagi setiap sumbernya.",
    zh: "请选择其单个资源的称呼。",
  },
  "Choose what one of them is called.": {
    ms: "Pilih panggilan bagi setiap satu daripadanya.",
    zh: "请选择单个资源的称呼。",
  },
  "Class hours are outside operating hours.": {
    ms: "Waktu kelas di luar waktu operasi.",
    zh: "课程时间超出营业时间。",
  },
  "Class name is required.": {
    ms: "Nama kelas diperlukan.",
    zh: "须填写课程名称。",
  },
  "Coach not found.": {
    ms: "Jurulatih tidak dijumpai.",
    zh: "找不到教练。",
  },
  "Codes are paused for now. Please verify via WhatsApp instead, or try again later.": {
    ms: "Kod dihentikan sementara. Sila sahkan melalui WhatsApp, atau cuba lagi kemudian.",
    zh: "验证码暂停发送。请改用 WhatsApp 验证，或稍后再试。",
  },
  "Count strikes over 7 to 365 days.": {
    ms: "Kira rekod kesalahan dalam tempoh 7 hingga 365 hari.",
    zh: "违规次数的统计期须为 7 至 365 天。",
  },
  "Court name is required.": {
    ms: "Nama gelanggang diperlukan.",
    zh: "须填写场地名称。",
  },
  "Court name is too short.": {
    ms: "Nama gelanggang terlalu pendek.",
    zh: "场地名称太短。",
  },
  "Credit belongs to a venue here: say which one sold it.": {
    ms: "Kredit di sini milik pusat tertentu: nyatakan pusat yang menjualnya.",
    zh: "此处的储值属于各场馆：请注明售出的场馆。",
  },
  "Credit is bought at the counter here.": {
    ms: "Kredit dibeli di kaunter di sini.",
    zh: "此处的储值须在柜台购买。",
  },
  "Customer not found.": {
    ms: "Pelanggan tidak dijumpai.",
    zh: "找不到顾客。",
  },
  "Days are 0 (Sunday) to 6 (Saturday).": {
    ms: "Hari ialah 0 (Ahad) hingga 6 (Sabtu).",
    zh: "星期须为 0（星期日）至 6（星期六）。",
  },
  "Deductions are a list of reasons and amounts.": {
    ms: "Potongan ialah senarai sebab dan jumlah.",
    zh: "扣款须为原因和金额的列表。",
  },
  "Describe what the code is for.": {
    ms: "Terangkan tujuan kod ini.",
    zh: "请说明此代码的用途。",
  },
  "Drop the pin on the map where the venue is.": {
    ms: "Letakkan pin pada peta di lokasi pusat.",
    zh: "请在地图上标出场馆位置。",
  },
  "Each activity once.": {
    ms: "Setiap aktiviti sekali sahaja.",
    zh: "每项活动只能出现一次。",
  },
  "Each day's hours open before they close, by 4 AM the next morning.": {
    ms: "Waktu setiap hari mesti dibuka sebelum ditutup, selewat-lewatnya 4 pagi keesokan harinya.",
    zh: "每天的营业时间须先开后关，最晚至次日凌晨 4 点。",
  },
  "Each fixed price is a length in minutes and an amount.": {
    ms: "Setiap harga tetap ialah tempoh dalam minit dan jumlah.",
    zh: "每个固定价格须包含时长（分钟）和金额。",
  },
  "Each larger booking gets a lower price than the last.": {
    ms: "Setiap tempahan yang lebih besar mendapat harga lebih rendah daripada sebelumnya.",
    zh: "预订量越大，价格须比上一档越低。",
  },
  "Each name on the roster is 2 to 60 letters.": {
    ms: "Setiap nama dalam senarai pemain mestilah 2 hingga 60 huruf.",
    zh: "名单上的每个名字须为 2 至 60 个字符。",
  },
  "Each reason once: add its amounts together.": {
    ms: "Setiap sebab sekali sahaja: jumlahkan amaunnya.",
    zh: "每个原因只能出现一次：请合并其金额。",
  },
  "Each tier needs a name of up to 40 characters.": {
    ms: "Setiap peringkat memerlukan nama sehingga 40 aksara.",
    zh: "每个等级须有不超过 40 个字符的名称。",
  },
  "End the season being played first.": {
    ms: "Tamatkan musim yang sedang berlangsung dahulu.",
    zh: "请先结束正在进行的赛季。",
  },
  "Enter the phone number they gave.": {
    ms: "Masukkan nombor telefon yang mereka berikan.",
    zh: "请输入对方提供的电话号码。",
  },
  "Entries are not open.": {
    ms: "Penyertaan tidak dibuka.",
    zh: "目前不接受报名。",
  },
  "Entries must close before the first day.": {
    ms: "Penyertaan mesti ditutup sebelum hari pertama.",
    zh: "报名须在首日之前截止。",
  },
  "Every share is paid already.": {
    ms: "Setiap bahagian telah dibayar.",
    zh: "每一份都已付款。",
  },
  "Fill in the MyInvois credentials and the TIN first.": {
    ms: "Isi butiran log masuk MyInvois dan TIN dahulu.",
    zh: "请先填写 MyInvois 凭证和 TIN。",
  },
  "Fixtures are moved once the draw is made, until it is over.": {
    ms: "Perlawanan boleh dipindah selepas undian dibuat, sehingga ia tamat.",
    zh: "抽签后至赛事结束前才可调整赛程。",
  },
  "Front-desk accounts cannot change this. Ask a manager.": {
    ms: "Akaun kaunter hadapan tidak boleh mengubah ini. Minta pengurus.",
    zh: "前台账户不能更改此项。请联系经理。",
  },
  "Gift vouchers are sold at the counter here.": {
    ms: "Baucar hadiah dijual di kaunter di sini.",
    zh: "此处的礼券须在柜台购买。",
  },
  "Give a courtId, a venueId and sport, or a classId.": {
    ms: "Berikan courtId, venueId dan sport, atau classId.",
    zh: "请提供 courtId，或 venueId 和 sport，或 classId。",
  },
  "Give a courtId, or a venueId and sport to pick one for you.": {
    ms: "Berikan courtId, atau venueId dan sport untuk memilih satu untuk anda.",
    zh: "请提供 courtId，或提供 venueId 和 sport 以自动选择场地。",
  },
  "Give a courtId, or a venueId and sport.": {
    ms: "Berikan courtId, atau venueId dan sport.",
    zh: "请提供 courtId，或 venueId 和 sport。",
  },
  "Give a phone number customers can call.": {
    ms: "Berikan nombor telefon yang boleh dihubungi pelanggan.",
    zh: "请提供顾客可拨打的电话号码。",
  },
  "Give a valid email address.": {
    ms: "Berikan alamat e-mel yang sah.",
    zh: "请提供有效的电邮地址。",
  },
  "Give an API key: Authorization: Bearer <key>.": {
    ms: "Berikan kunci API: Authorization: Bearer <key>.",
    zh: "请提供 API 密钥：Authorization: Bearer <key>。",
  },
  "Give an email address the invoices go to.": {
    ms: "Berikan alamat e-mel penerima invois.",
    zh: "请提供接收发票的电邮地址。",
  },
  "Give an end, or a length in minutes.": {
    ms: "Berikan waktu tamat, atau tempoh dalam minit.",
    zh: "请提供结束时间或时长（分钟）。",
  },
  "Give both ends of the staffed window, or neither.": {
    ms: "Berikan kedua-dua hujung tempoh ada kakitangan, atau tidak langsung.",
    zh: "有人值守时段须同时填写开始和结束，或都不填。",
  },
  "Give each competitor's mark, or say why there is none.": {
    ms: "Berikan markah setiap peserta, atau nyatakan sebab tiada markah.",
    zh: "请填写每位参赛者的成绩，或说明没有成绩的原因。",
  },
  "Give each match 5 minutes to 10 hours.": {
    ms: "Berikan setiap perlawanan 5 minit hingga 10 jam.",
    zh: "每场比赛时长须为 5 分钟至 10 小时。",
  },
  "Give each stage's matches 5 minutes to 10 hours.": {
    ms: "Berikan perlawanan setiap peringkat 5 minit hingga 10 jam.",
    zh: "每个阶段的比赛时长须为 5 分钟至 10 小时。",
  },
  "Give hours inside the day's opening hours, the first before the last.": {
    ms: "Berikan jam dalam waktu operasi hari itu, yang pertama sebelum yang terakhir.",
    zh: "请填写当天营业时间内的时段，开始须早于结束。",
  },
  "Give it a name.": {
    ms: "Berikan nama.",
    zh: "请填写名称。",
  },
  "Give seven days, Sunday first.": {
    ms: "Berikan tujuh hari, bermula hari Ahad.",
    zh: "请提供七天的数据，从星期日开始。",
  },
  "Give stage lengths in minutes.": {
    ms: "Berikan tempoh peringkat dalam minit.",
    zh: "请以分钟填写各阶段时长。",
  },
  "Give start and end (minutes of the day, or HH:MM), or hours as a list of grid times.": {
    ms: "Berikan mula dan tamat (minit dalam hari, atau HH:MM), atau jam sebagai senarai masa grid.",
    zh: "请提供开始和结束时间（当天的分钟数或 HH:MM），或以时间格列表提供时段。",
  },
  "Give start, and end or minutes.": {
    ms: "Berikan waktu mula, dan waktu tamat atau minit.",
    zh: "请提供开始时间，以及结束时间或分钟数。",
  },
  "Give the account a name: the company or school.": {
    ms: "Namakan akaun: syarikat atau sekolah.",
    zh: "请为账户命名：公司或学校名称。",
  },
  "Give the area the branch is in.": {
    ms: "Berikan kawasan cawangan.",
    zh: "请填写分店所在地区。",
  },
  "Give the area the venue is in.": {
    ms: "Berikan kawasan pusat.",
    zh: "请填写场馆所在地区。",
  },
  "Give the branch's address.": {
    ms: "Berikan alamat cawangan.",
    zh: "请填写分店地址。",
  },
  "Give the branch's name.": {
    ms: "Berikan nama cawangan.",
    zh: "请填写分店名称。",
  },
  "Give the coach's name.": {
    ms: "Berikan nama jurulatih.",
    zh: "请填写教练姓名。",
  },
  "Give the court's hours for seven days, Sunday first.": {
    ms: "Berikan waktu gelanggang untuk tujuh hari, bermula hari Ahad.",
    zh: "请提供场地七天的时间，从星期日开始。",
  },
  "Give the courts this one takes, as a list.": {
    ms: "Berikan gelanggang yang dirangkumi oleh gelanggang ini, sebagai senarai.",
    zh: "请以列表提供此场地包含的场地。",
  },
  "Give the customer's phone number.": {
    ms: "Berikan nombor telefon pelanggan.",
    zh: "请提供顾客的电话号码。",
  },
  "Give the domain alone, like abcbadminton.com.": {
    ms: "Berikan domain sahaja, contohnya abcbadminton.com.",
    zh: "只需填写域名，例如 abcbadminton.com。",
  },
  "Give the first and last day off.": {
    ms: "Berikan hari pertama dan terakhir cuti.",
    zh: "请填写休假的首日和最后一天。",
  },
  "Give the first and last day.": {
    ms: "Berikan hari pertama dan terakhir.",
    zh: "请填写首日和最后一天。",
  },
  "Give the first day it is out.": {
    ms: "Berikan hari pertama ia tidak boleh digunakan.",
    zh: "请填写停用的首日。",
  },
  "Give the group a name.": {
    ms: "Namakan kumpulan.",
    zh: "请为群组命名。",
  },
  "Give the last day entries are taken.": {
    ms: "Berikan hari terakhir penyertaan diterima.",
    zh: "请填写报名截止日。",
  },
  "Give the last day it is out, or none.": {
    ms: "Berikan hari terakhir ia tidak boleh digunakan, atau tiada.",
    zh: "请填写停用的最后一天，或留空。",
  },
  "Give the match 5 minutes to 10 hours.": {
    ms: "Berikan perlawanan 5 minit hingga 10 jam.",
    zh: "比赛时长须为 5 分钟至 10 小时。",
  },
  "Give the official's name.": {
    ms: "Berikan nama pegawai perlawanan.",
    zh: "请填写裁判姓名。",
  },
  "Give the pass a name.": {
    ms: "Namakan pas.",
    zh: "请为次卡命名。",
  },
  "Give the peak times as whole minutes of the day, or the venue's.": {
    ms: "Berikan waktu puncak sebagai minit penuh dalam hari, atau guna tetapan pusat.",
    zh: "请以当天的整分钟数填写高峰时段，或沿用场馆的设置。",
  },
  "Give the plan a name of 2–60 characters.": {
    ms: "Berikan nama pelan 2–60 aksara.",
    zh: "请为方案填写 2–60 个字符的名称。",
  },
  "Give the score of the draw.": {
    ms: "Berikan skor perlawanan seri.",
    zh: "请填写平局的比分。",
  },
  "Give the score, or mark it a walkover or a retirement.": {
    ms: "Berikan skor, atau tandakan sebagai walkover atau tarik diri.",
    zh: "请填写比分，或标记为不战而胜或中途退赛。",
  },
  "Give the score, or mark it a walkover.": {
    ms: "Berikan skor, atau tandakan sebagai walkover.",
    zh: "请填写比分，或标记为不战而胜。",
  },
  "Give the score, or report a walkover.": {
    ms: "Berikan skor, atau laporkan walkover.",
    zh: "请填写比分，或报告不战而胜。",
  },
  "Give the template a name.": {
    ms: "Namakan templat.",
    zh: "请为模板命名。",
  },
  "Give the venue's address.": {
    ms: "Berikan alamat pusat.",
    zh: "请填写场馆地址。",
  },
  "Give the venue's name.": {
    ms: "Berikan nama pusat.",
    zh: "请填写场馆名称。",
  },
  "Give their name.": {
    ms: "Berikan nama mereka.",
    zh: "请填写对方姓名。",
  },
  "Give their phone number.": {
    ms: "Berikan nombor telefon mereka.",
    zh: "请填写对方电话号码。",
  },
  "Give up to five quantity prices.": {
    ms: "Berikan sehingga lima harga kuantiti.",
    zh: "最多可设五个数量价。",
  },
  "Give your name and phone number.": {
    ms: "Berikan nama dan nombor telefon anda.",
    zh: "请填写您的姓名和电话号码。",
  },
  "Give your name.": {
    ms: "Berikan nama anda.",
    zh: "请填写您的姓名。",
  },
  "Google could not be reached. Try again.": {
    ms: "Google tidak dapat dihubungi. Cuba lagi.",
    zh: "无法连接 Google。请重试。",
  },
  "Google did not accept the sign-in. Try again.": {
    ms: "Google tidak menerima log masuk ini. Cuba lagi.",
    zh: "Google 未接受此次登录。请重试。",
  },
  "Google did not share an email address.": {
    ms: "Google tidak berkongsi alamat e-mel.",
    zh: "Google 未提供电邮地址。",
  },
  "Google sent no answer. Try again.": {
    ms: "Google tidak memberi jawapan. Cuba lagi.",
    zh: "Google 没有回应。请重试。",
  },
  "Google sign-in was cancelled.": {
    ms: "Log masuk Google dibatalkan.",
    zh: "Google 登录已取消。",
  },
  "Google's answer could not be read. Try again.": {
    ms: "Jawapan Google tidak dapat dibaca. Cuba lagi.",
    zh: "无法读取 Google 的回应。请重试。",
  },
  "Google's answer was not for this sign-in. Try again.": {
    ms: "Jawapan Google bukan untuk log masuk ini. Cuba lagi.",
    zh: "Google 的回应与此次登录不符。请重试。",
  },
  "Guest not found.": {
    ms: "Tetamu tidak dijumpai.",
    zh: "找不到访客。",
  },
  "Hold a booking for 5 to 60 minutes.": {
    ms: "Tahan tempahan selama 5 hingga 60 minit.",
    zh: "预订保留时间须为 5 至 60 分钟。",
  },
  "Hold at least one court.": {
    ms: "Tahan sekurang-kurangnya satu gelanggang.",
    zh: "请至少保留一个场地。",
  },
  "Hold only this venue's courts for that sport.": {
    ms: "Tahan hanya gelanggang pusat ini untuk sukan itu.",
    zh: "只能保留本场馆该运动项目的场地。",
  },
  "How close to the start: 1 to 24 hours.": {
    ms: "Berapa hampir dengan waktu mula: 1 hingga 24 jam.",
    zh: "距开始时间：须为 1 至 24 小时。",
  },
  "How far: 1 to 100 km.": {
    ms: "Berapa jauh: 1 hingga 100 km.",
    zh: "距离：1 至 100 公里。",
  },
  "How many messages? A whole number, not 0.": {
    ms: "Berapa banyak mesej? Nombor bulat, bukan 0.",
    zh: "多少条信息？须为非零整数。",
  },
  "Indoor, outdoor or neither.": {
    ms: "Dalaman, luaran atau bukan kedua-duanya.",
    zh: "室内、室外或皆不是。",
  },
  "Indoor, outdoor, or not said.": {
    ms: "Dalaman, luaran, atau tidak dinyatakan.",
    zh: "室内、室外或未注明。",
  },
  "Induction not found.": {
    ms: "Taklimat pengenalan tidak dijumpai.",
    zh: "找不到入门培训记录。",
  },
  "Instructor name is required.": {
    ms: "Nama pengajar diperlukan.",
    zh: "须填写导师姓名。",
  },
  "Invalid JSON body.": {
    ms: "Badan JSON tidak sah.",
    zh: "JSON 请求内容无效。",
  },
  "Invalid admin id.": {
    ms: "ID pentadbir tidak sah.",
    zh: "管理员 ID 无效。",
  },
  "Invalid businessId.": {
    ms: "businessId tidak sah.",
    zh: "businessId 无效。",
  },
  "Invalid class id.": {
    ms: "ID kelas tidak sah.",
    zh: "课程 ID 无效。",
  },
  "Invalid code id.": {
    ms: "ID kod tidak sah.",
    zh: "代码 ID 无效。",
  },
  "Invalid court id.": {
    ms: "ID gelanggang tidak sah.",
    zh: "场地 ID 无效。",
  },
  "Invalid date.": {
    ms: "Tarikh tidak sah.",
    zh: "日期无效。",
  },
  "Invalid date. Use YYYY-MM-DD.": {
    ms: "Tarikh tidak sah. Gunakan YYYY-MM-DD.",
    zh: "日期无效。请使用 YYYY-MM-DD 格式。",
  },
  "Invalid dates.": {
    ms: "Tarikh-tarikh tidak sah.",
    zh: "日期无效。",
  },
  "Invalid expiry date.": {
    ms: "Tarikh luput tidak sah.",
    zh: "到期日无效。",
  },
  "Invalid game.": {
    ms: "Permainan tidak sah.",
    zh: "球局无效。",
  },
  "Invalid group.": {
    ms: "Kumpulan tidak sah.",
    zh: "群组无效。",
  },
  "Invalid id.": {
    ms: "ID tidak sah.",
    zh: "ID 无效。",
  },
  "Invalid induction id.": {
    ms: "ID taklimat pengenalan tidak sah.",
    zh: "入门培训 ID 无效。",
  },
  "Invalid membership id.": {
    ms: "ID keahlian tidak sah.",
    zh: "会员资格 ID 无效。",
  },
  "Invalid pass id.": {
    ms: "ID pas tidak sah.",
    zh: "次卡 ID 无效。",
  },
  "Invalid sale id.": {
    ms: "ID jualan tidak sah.",
    zh: "销售 ID 无效。",
  },
  "Invalid start date. Use YYYY-MM-DD.": {
    ms: "Tarikh mula tidak sah. Gunakan YYYY-MM-DD.",
    zh: "开始日期无效。请使用 YYYY-MM-DD 格式。",
  },
  "Invalid venue id.": {
    ms: "ID pusat tidak sah.",
    zh: "场馆 ID 无效。",
  },
  "Invalid venueId.": {
    ms: "venueId tidak sah.",
    zh: "venueId 无效。",
  },
  "Invalid voucher id.": {
    ms: "ID baucar tidak sah.",
    zh: "礼券 ID 无效。",
  },
  "Invoice not found.": {
    ms: "Invois tidak dijumpai.",
    zh: "找不到发票。",
  },
  "Invoices can be written in one of this site's languages only.": {
    ms: "Invois hanya boleh ditulis dalam salah satu bahasa laman ini.",
    zh: "发票只能使用本网站支持的语言。",
  },
  "It cannot start in the past.": {
    ms: "Ia tidak boleh bermula pada masa lalu.",
    zh: "开始时间不能是过去。",
  },
  "It has to start after today, so players can enter.": {
    ms: "Ia mesti bermula selepas hari ini, supaya pemain boleh mendaftar.",
    zh: "须在今天之后开始，以便球员报名。",
  },
  "It is not on an account, or is invoiced already.": {
    ms: "Ia bukan di bawah akaun, atau sudah diinvois.",
    zh: "此项不在账户上，或已开具发票。",
  },
  "It is waiting for approval already.": {
    ms: "Ia sudah menunggu kelulusan.",
    zh: "已在等待审批。",
  },
  "It is your own game.": {
    ms: "Ini permainan anda sendiri.",
    zh: "这是您自己的球局。",
  },
  "It runs out today or later, or never.": {
    ms: "Ia tamat tempoh hari ini atau kemudian, atau tidak pernah.",
    zh: "到期日须为今天或以后，或永不到期。",
  },
  "Its whole business is suspended. Lift that instead.": {
    ms: "Seluruh perniagaannya digantung. Tarik balik penggantungan itu.",
    zh: "其整个企业已被暂停。请解除企业的暂停。",
  },
  "Keep 0 to 100 percent of a late cancellation, no cancelling online, or the venue's.": {
    ms: "Simpan 0 hingga 100 peratus bagi pembatalan lewat, tiada pembatalan dalam talian, atau ikut tetapan pusat.",
    zh: "逾期取消扣留 0% 至 100%、不允许在线取消，或沿用场馆的设置。",
  },
  "Keep 0 to 100 percent, or leave late cancelling off.": {
    ms: "Simpan 0 hingga 100 peratus, atau biarkan pembatalan lewat dimatikan.",
    zh: "扣留 0% 至 100%，或关闭逾期取消。",
  },
  "Key not found.": {
    ms: "Kunci tidak dijumpai.",
    zh: "找不到密钥。",
  },
  "Kit is out on hire at this venue. Somebody has to be here to take it back.": {
    ms: "Peralatan sedang disewa di pusat ini. Seseorang perlu ada di sini untuk menerimanya kembali.",
    zh: "本场馆有装备正在出租。须有人在场收回。",
  },
  "List lengths as whole minutes.": {
    ms: "Senaraikan tempoh sebagai minit penuh.",
    zh: "时长须以整分钟列出。",
  },
  "List prices by length.": {
    ms: "Senaraikan harga mengikut tempoh.",
    zh: "请按时长列出价格。",
  },
  "List start times as minutes of the day.": {
    ms: "Senaraikan masa mula sebagai minit dalam hari.",
    zh: "开始时间须以当天的分钟数列出。",
  },
  "Match not found.": {
    ms: "Perlawanan tidak dijumpai.",
    zh: "找不到比赛。",
  },
  "Membership not found.": {
    ms: "Keahlian tidak dijumpai.",
    zh: "找不到会员资格。",
  },
  "Message not found.": {
    ms: "Mesej tidak dijumpai.",
    zh: "找不到信息。",
  },
  "Mixed is doubles: one woman and one man.": {
    ms: "Beregu campuran ialah seorang wanita dan seorang lelaki.",
    zh: "混双为一男一女搭档。",
  },
  "Morning, afternoon or evening.": {
    ms: "Pagi, petang atau malam.",
    zh: "上午、下午或晚上。",
  },
  "Name each item typed in (2 to 60 characters).": {
    ms: "Namakan setiap item yang ditaip (2 hingga 60 aksara).",
    zh: "请为每个手动输入的商品命名（2 至 60 个字符）。",
  },
  "Name is required.": {
    ms: "Nama diperlukan.",
    zh: "须填写姓名。",
  },
  "Name it, as customers will see it: Student, Senior (60+).": {
    ms: "Namakannya seperti yang dilihat pelanggan: Pelajar, Warga Emas (60+).",
    zh: "请填写顾客看到的名称：学生、乐龄人士（60 岁以上）。",
  },
  "Name the holiday, such as Hari Raya Aidilfitri.": {
    ms: "Namakan cuti, contohnya Hari Raya Aidilfitri.",
    zh: "请填写假期名称，例如开斋节（Hari Raya Aidilfitri）。",
  },
  "Name the key after what will use it.": {
    ms: "Namakan kunci mengikut apa yang akan menggunakannya.",
    zh: "请按使用此密钥的系统命名。",
  },
  "Name who reviewed it: the accountant or tax adviser, and their firm.": {
    ms: "Namakan penyemak: akauntan atau penasihat cukai, dan firma mereka.",
    zh: "请注明审核人：会计师或税务顾问，以及其所属事务所。",
  },
  "Name your partner.": {
    ms: "Namakan pasangan anda.",
    zh: "请填写您的搭档。",
  },
  "Name your team.": {
    ms: "Namakan pasukan anda.",
    zh: "请为您的队伍命名。",
  },
  "Never, a daily digest, or each game.": {
    ms: "Tidak pernah, ringkasan harian, atau setiap permainan.",
    zh: "从不、每日摘要或每个球局。",
  },
  "No account has that email address. Leave it blank to sell without one.": {
    ms: "Tiada akaun dengan alamat e-mel itu. Biarkan kosong untuk menjual tanpa akaun.",
    zh: "没有账户使用该电邮地址。留空即可在无账户的情况下出售。",
  },
  "No account has that email.": {
    ms: "Tiada akaun dengan e-mel itu.",
    zh: "没有账户使用该电邮。",
  },
  "No deposit is held on this booking.": {
    ms: "Tiada deposit dipegang untuk tempahan ini.",
    zh: "此预订没有押金。",
  },
  "No phone numbers found.": {
    ms: "Tiada nombor telefon dijumpai.",
    zh: "找不到电话号码。",
  },
  "No season is being played.": {
    ms: "Tiada musim sedang berlangsung.",
    zh: "目前没有进行中的赛季。",
  },
  "No season is waiting to start.": {
    ms: "Tiada musim menunggu untuk bermula.",
    zh: "没有待开始的赛季。",
  },
  "No such enquiry here, or no such answer.": {
    ms: "Tiada pertanyaan sedemikian di sini, atau tiada jawapan sedemikian.",
    zh: "此处没有该咨询，或没有该回复。",
  },
  "No such holiday.": {
    ms: "Tiada cuti sedemikian.",
    zh: "没有该假期。",
  },
  "No such payment gateway.": {
    ms: "Tiada gerbang pembayaran sedemikian.",
    zh: "没有该支付网关。",
  },
  "No unpaid sessions found for that series.": {
    ms: "Tiada sesi belum dibayar dijumpai untuk siri itu.",
    zh: "该系列没有未付款的场次。",
  },
  "Nobody has agreed to hear from this venue yet.": {
    ms: "Belum ada sesiapa bersetuju menerima berita daripada pusat ini.",
    zh: "目前还没有人同意接收本场馆的信息。",
  },
  "Nobody is in it yet.": {
    ms: "Belum ada sesiapa di dalamnya.",
    zh: "目前还没有人参加。",
  },
  "Nobody is level for the final's last place.": {
    ms: "Tiada sesiapa terikat sama untuk tempat terakhir di final.",
    zh: "没有人并列争夺决赛最后一个名额。",
  },
  "Not a backup this install can read.": {
    ms: "Ini bukan sandaran yang boleh dibaca oleh pemasangan ini.",
    zh: "这不是本系统可读取的备份。",
  },
  "Not a marketplace.": {
    ms: "Ini bukan platform pasaran.",
    zh: "这不是多商家平台。",
  },
  "Not found, or already reviewed.": {
    ms: "Tidak dijumpai, atau sudah disemak.",
    zh: "找不到，或已审核。",
  },
  "Not found, or withdrawn already.": {
    ms: "Tidak dijumpai, atau sudah ditarik balik.",
    zh: "找不到，或已撤回。",
  },
  "Not found.": {
    ms: "Tidak dijumpai.",
    zh: "找不到。",
  },
  "Not subscribed.": {
    ms: "Tidak melanggan.",
    zh: "未订阅。",
  },
  "Nothing by that name is booked here.": {
    ms: "Tiada apa-apa dengan nama itu ditempah di sini.",
    zh: "此处没有该名称的预订。",
  },
  "Nothing is owed back on that payment.": {
    ms: "Tiada bayaran balik terhutang bagi bayaran itu.",
    zh: "该笔付款没有待退款项。",
  },
  "Nothing of that is still to come.": {
    ms: "Tiada daripadanya yang akan datang lagi.",
    zh: "其中已没有未来的时段。",
  },
  "Nothing on the account to invoice up to then.": {
    ms: "Tiada apa-apa dalam akaun untuk diinvois sehingga tarikh itu.",
    zh: "截至该日期，账户上没有可开具发票的项目。",
  },
  "Nothing to buy: this install pays Meta itself.": {
    ms: "Tiada apa untuk dibeli: pemasangan ini membayar Meta sendiri.",
    zh: "无需购买：本系统直接向 Meta 付费。",
  },
  "Nothing to change.": {
    ms: "Tiada apa untuk diubah.",
    zh: "没有需要更改的内容。",
  },
  "Nothing to give back.": {
    ms: "Tiada apa untuk dipulangkan.",
    zh: "没有可退还的款项。",
  },
  "Nothing to update.": {
    ms: "Tiada apa untuk dikemas kini.",
    zh: "没有需要更新的内容。",
  },
  "Notice is 0 minutes to a week.": {
    ms: "Notis ialah 0 minit hingga seminggu.",
    zh: "提前通知时间须为 0 分钟至一周。",
  },
  "Numbers are checked here: ask for a code.": {
    ms: "Nombor disahkan di sini: minta kod.",
    zh: "此处须验证号码：请索取验证码。",
  },
  "Off, urgent only, or everything.": {
    ms: "Mati, penting sahaja, atau semua.",
    zh: "关闭、仅紧急或全部。",
  },
  "One or two go up and down.": {
    ms: "Satu atau dua pemain naik dan turun.",
    zh: "每组升降一或两人。",
  },
  "One price per length.": {
    ms: "Satu harga bagi setiap tempoh.",
    zh: "每个时长一个价格。",
  },
  "Only a business manager can add a branch.": {
    ms: "Hanya pengurus perniagaan boleh menambah cawangan.",
    zh: "只有企业经理可以添加分店。",
  },
  "Only a business manager or the platform owner can do that.": {
    ms: "Hanya pengurus perniagaan atau pemilik platform boleh melakukannya.",
    zh: "只有企业经理或平台所有者可以执行此操作。",
  },
  "Only a court booked whole can take others: this one sells places.": {
    ms: "Hanya gelanggang yang ditempah sepenuhnya boleh merangkumi gelanggang lain: gelanggang ini menjual tempat.",
    zh: "只有整场预订的场地才能包含其他场地：此场地按名额出售。",
  },
  "Only a manager can correct a result after the knockout has begun.": {
    ms: "Hanya pengurus boleh membetulkan keputusan selepas kalah mati bermula.",
    zh: "淘汰赛开始后，只有经理可以更正比赛结果。",
  },
  "Only a manager can disqualify an entrant.": {
    ms: "Hanya pengurus boleh membatalkan kelayakan peserta.",
    zh: "只有经理可以取消参赛者资格。",
  },
  "Only a manager can move a fixture.": {
    ms: "Hanya pengurus boleh memindah perlawanan.",
    zh: "只有经理可以调整赛程。",
  },
  "Only a manager can resolve a correction's consequences.": {
    ms: "Hanya pengurus boleh menyelesaikan akibat sesuatu pembetulan.",
    zh: "只有经理可以处理更正带来的后续影响。",
  },
  "Only a manager may move a booking outside the court's booking rules.": {
    ms: "Hanya pengurus boleh memindah tempahan di luar peraturan tempahan gelanggang.",
    zh: "只有经理可以在场地预订规则之外调整预订。",
  },
  "Only a manager of this venue may book outside its booking rules.": {
    ms: "Hanya pengurus pusat ini boleh menempah di luar peraturan tempahannya.",
    zh: "只有本场馆的经理可以在预订规则之外预订。",
  },
  "Only a message that was not sent can be sent again.": {
    ms: "Hanya mesej yang tidak dihantar boleh dihantar semula.",
    zh: "只有未发送成功的信息才能重新发送。",
  },
  "Only a voucher nobody has used can be cancelled.": {
    ms: "Hanya baucar yang belum digunakan sesiapa boleh dibatalkan.",
    zh: "只有未被使用过的礼券才能取消。",
  },
  "Only an unpaid invoice can be voided.": {
    ms: "Hanya invois belum dibayar boleh dibatalkan.",
    zh: "只有未付款的发票才能作废。",
  },
  "Only branch staff have a role; business managers always manage.": {
    ms: "Hanya kakitangan cawangan mempunyai peranan; pengurus perniagaan sentiasa mengurus.",
    zh: "只有分店员工有角色；企业经理始终拥有管理权限。",
  },
  "Only its owner can change that activity.": {
    ms: "Hanya pemiliknya boleh mengubah aktiviti itu.",
    zh: "只有该活动的所有者可以更改。",
  },
  "Only once the game has started.": {
    ms: "Hanya selepas permainan bermula.",
    zh: "须在球局开始后才可以。",
  },
  "Only one that failed or was found invalid can be sent again.": {
    ms: "Hanya yang gagal atau didapati tidak sah boleh dihantar semula.",
    zh: "只有失败或被判定无效的才能重新提交。",
  },
  "Only players who say they are 18 or over can be found or invited by other players.": {
    ms: "Hanya pemain yang menyatakan mereka berumur 18 tahun ke atas boleh dicari atau dijemput oleh pemain lain.",
    zh: "只有自称年满 18 岁的球员才能被其他球员搜索或邀请。",
  },
  "Only somebody who was in the game can miss it.": {
    ms: "Hanya orang yang menyertai permainan boleh ditanda tidak hadir.",
    zh: "只有已加入球局的人才能被标记为未到场。",
  },
  "Only the host can invite people to this game.": {
    ms: "Hanya hos boleh menjemput orang ke permainan ini.",
    zh: "只有发起人可以邀请他人加入此球局。",
  },
  "Only the platform owner can do that.": {
    ms: "Hanya pemilik platform boleh melakukannya.",
    zh: "只有平台所有者可以执行此操作。",
  },
  "Only the platform owner puts up a site-wide notice.": {
    ms: "Hanya pemilik platform boleh memaparkan notis untuk seluruh laman.",
    zh: "只有平台所有者可以发布全站公告。",
  },
  "Only the platform's owner sees every venue's refunds.": {
    ms: "Hanya pemilik platform dapat melihat bayaran balik semua pusat.",
    zh: "只有平台所有者可以查看所有场馆的退款。",
  },
  "Only unpaid bookings here, not yet invoiced, can go on an account.": {
    ms: "Hanya tempahan belum dibayar di sini, yang belum diinvois, boleh dimasukkan ke akaun.",
    zh: "只有本场馆未付款且尚未开具发票的预订才能记入账户。",
  },
  "Only whoever runs the business records a sign-off for every branch.": {
    ms: "Hanya pengendali perniagaan boleh merekod pengesahan untuk semua cawangan.",
    zh: "只有企业的负责人可以为所有分店记录资格确认。",
  },
  "Only whoever runs the business sets rules for every branch.": {
    ms: "Hanya pengendali perniagaan boleh menetapkan peraturan untuk semua cawangan.",
    zh: "只有企业的负责人可以为所有分店设定规则。",
  },
  "Only whoever runs the business takes back a sign-off for every branch.": {
    ms: "Hanya pengendali perniagaan boleh menarik balik pengesahan untuk semua cawangan.",
    zh: "只有企业的负责人可以撤销所有分店的资格确认。",
  },
  "Open, women's, men's or mixed.": {
    ms: "Terbuka, wanita, lelaki atau campuran.",
    zh: "公开组、女子组、男子组或混合组。",
  },
  "Opening hours are times of day, from midnight to 4 AM the next morning.": {
    ms: "Waktu operasi ialah masa dalam hari, dari tengah malam hingga 4 pagi keesokan harinya.",
    zh: "营业时间须为当天的时间，从午夜至次日凌晨 4 点。",
  },
  "Opening hours are whole minutes.": {
    ms: "Waktu operasi ialah minit penuh.",
    zh: "营业时间须为整分钟。",
  },
  "Over 18, under 18, or not saying.": {
    ms: "18 tahun ke atas, bawah 18 tahun, atau tidak dinyatakan.",
    zh: "18 岁以上、未满 18 岁或不透露。",
  },
  "Paid, or not?": {
    ms: "Sudah dibayar, atau belum?",
    zh: "已付款还是未付款？",
  },
  "Pay for the court first: this venue holds it only until it is paid.": {
    ms: "Bayar gelanggang dahulu: pusat ini hanya menahannya sehingga dibayar.",
    zh: "请先支付场地费：本场馆只保留到付款为止。",
  },
  "Paying invoices online is not set up. Pay by bank transfer.": {
    ms: "Pembayaran invois dalam talian belum disediakan. Bayar melalui pindahan bank.",
    zh: "尚未设置在线支付发票。请通过银行转账付款。",
  },
  "Paying online is not set up. Pay by bank transfer and ask for the pack to be marked paid.": {
    ms: "Pembayaran dalam talian belum disediakan. Bayar melalui pindahan bank dan minta pek ditanda sebagai dibayar.",
    zh: "尚未设置在线付款。请通过银行转账付款，并要求将该配套标记为已付款。",
  },
  "Peak ends before it starts.": {
    ms: "Waktu puncak tamat sebelum ia bermula.",
    zh: "高峰时段的结束时间早于开始时间。",
  },
  "Peak hours end after they start.": {
    ms: "Waktu puncak mesti tamat selepas ia bermula.",
    zh: "高峰时段须在开始之后结束。",
  },
  "Peak times are whole minutes of the day, from midnight to 4 AM the next morning.": {
    ms: "Waktu puncak ialah minit penuh dalam hari, dari tengah malam hingga 4 pagi keesokan harinya.",
    zh: "高峰时段须为当天的整分钟，从午夜至次日凌晨 4 点。",
  },
  "Photo not found.": {
    ms: "Foto tidak dijumpai.",
    zh: "找不到照片。",
  },
  "Pick a date to come, or leave it blank.": {
    ms: "Pilih tarikh untuk datang, atau biarkan kosong.",
    zh: "请选择到访日期，或留空。",
  },
  "Pick a date.": {
    ms: "Pilih tarikh.",
    zh: "请选择日期。",
  },
  "Pick a day from today on.": {
    ms: "Pilih hari mulai hari ini.",
    zh: "请选择今天或之后的日期。",
  },
  "Places are 1 to 500.": {
    ms: "Tempat ialah 1 hingga 500.",
    zh: "名额须为 1 至 500。",
  },
  "Plan not found.": {
    ms: "Pelan tidak dijumpai.",
    zh: "找不到方案。",
  },
  "Players, pairs or teams.": {
    ms: "Pemain, pasangan atau pasukan.",
    zh: "个人、双人组合或队伍。",
  },
  "Please fill in every field.": {
    ms: "Sila isi setiap ruangan.",
    zh: "请填写所有字段。",
  },
  "Please give a valid phone number.": {
    ms: "Sila berikan nombor telefon yang sah.",
    zh: "请提供有效的电话号码。",
  },
  "Please give the person's name.": {
    ms: "Sila berikan nama orang itu.",
    zh: "请提供此人的姓名。",
  },
  "Please sign in to enter.": {
    ms: "Sila log masuk untuk menyertai.",
    zh: "请登录后报名。",
  },
  "Please sign in to join a game.": {
    ms: "Sila log masuk untuk menyertai permainan.",
    zh: "请登录后加入球局。",
  },
  "Please sign in to join.": {
    ms: "Sila log masuk untuk menyertainya.",
    zh: "请登录后加入。",
  },
  "Please sign in.": {
    ms: "Sila log masuk.",
    zh: "请登录。",
  },
  "Points by set score are for matches scored in sets.": {
    ms: "Mata mengikut skor set adalah untuk perlawanan yang dikira mengikut set.",
    zh: "按局分计积分只适用于按局计分的比赛。",
  },
  "Points by set score are four whole numbers, 0 to 10: a clear win, a win in the deciding set, a loss in it, a clear loss.": {
    ms: "Mata mengikut skor set ialah empat nombor bulat, 0 hingga 10: menang mudah, menang dalam set penentu, kalah dalam set penentu, kalah mudah.",
    zh: "按局分计积分须为四个 0 至 10 的整数：完胜、决胜局获胜、决胜局落败、完败。",
  },
  "Price each part at its own rate, or all at the rate when it starts.": {
    ms: "Kenakan harga setiap bahagian pada kadarnya sendiri, atau semuanya pada kadar ketika ia bermula.",
    zh: "每个时段按各自的费率计价，或全部按开始时的费率计价。",
  },
  "Public or private.": {
    ms: "Awam atau persendirian.",
    zh: "公开或私人。",
  },
  "Results are not being taken.": {
    ms: "Keputusan tidak diterima sekarang.",
    zh: "目前不接受提交成绩。",
  },
  "Review not found.": {
    ms: "Ulasan tidak dijumpai.",
    zh: "找不到评价。",
  },
  "Review what this changes, then confirm it.": {
    ms: "Semak apa yang diubah oleh tindakan ini, kemudian sahkan.",
    zh: "请查看此操作带来的变化，然后确认。",
  },
  "Roughly how many people, or leave it blank.": {
    ms: "Anggaran bilangan orang, atau biarkan kosong.",
    zh: "大约多少人，或留空。",
  },
  "Rules are a set of choices.": {
    ms: "Peraturan ialah satu set pilihan.",
    zh: "规则须为一组选项。",
  },
  "Sale not found.": {
    ms: "Jualan tidak dijumpai.",
    zh: "找不到销售记录。",
  },
  "Say how it was paid.": {
    ms: "Nyatakan cara ia dibayar.",
    zh: "请注明付款方式。",
  },
  "Say how many days refunds by hand take: 1 to 30.": {
    ms: "Nyatakan berapa hari bayaran balik secara manual mengambil masa: 1 hingga 30.",
    zh: "请注明人工退款需要的天数：1 至 30。",
  },
  "Say how the deposit was paid.": {
    ms: "Nyatakan cara deposit dibayar.",
    zh: "请注明押金的付款方式。",
  },
  "Say suspend or lift.": {
    ms: "Nyatakan gantung atau tarik balik.",
    zh: "请注明暂停或解除。",
  },
  "Say taxed (true), not taxed (false), or the usual (null).": {
    ms: "Nyatakan dikenakan cukai (true), tidak dikenakan cukai (false), atau seperti biasa (null).",
    zh: "请注明应税（true）、免税（false）或按默认（null）。",
  },
  "Say what happened — a note is required when the kit is not returned fine.": {
    ms: "Nyatakan apa yang berlaku — nota diperlukan apabila peralatan tidak dipulangkan dalam keadaan baik.",
    zh: "请说明情况——装备未完好归还时须填写备注。",
  },
  "Say what is wrong with it.": {
    ms: "Nyatakan apa yang salah dengannya.",
    zh: "请说明问题所在。",
  },
  "Say what it is for.": {
    ms: "Nyatakan tujuannya.",
    zh: "请说明用途。",
  },
  "Say what it is for: customers see it.": {
    ms: "Nyatakan tujuannya: pelanggan dapat melihatnya.",
    zh: "请说明用途：顾客会看到。",
  },
  "Say what really happened.": {
    ms: "Nyatakan apa yang sebenarnya berlaku.",
    zh: "请说明实际情况。",
  },
  "Say what to show at the counter: your student card, your IC.": {
    ms: "Nyatakan apa yang perlu ditunjukkan di kaunter: kad pelajar anda, IC anda.",
    zh: "请注明在柜台须出示的证明：学生证、身份证。",
  },
  "Say whether fees are owed back before the draw.": {
    ms: "Nyatakan sama ada yuran dipulangkan sebelum undian.",
    zh: "请注明抽签前是否退还报名费。",
  },
  "Say whether the proof was seen.": {
    ms: "Nyatakan sama ada bukti telah dilihat.",
    zh: "请注明是否已核实证明。",
  },
  "Say which rule it breaks.": {
    ms: "Nyatakan peraturan yang dilanggarnya.",
    zh: "请注明违反了哪条规则。",
  },
  "Say which venue's credit this is.": {
    ms: "Nyatakan kredit pusat mana ini.",
    zh: "请注明这是哪个场馆的储值。",
  },
  "Say why each amount is kept back.": {
    ms: "Nyatakan sebab setiap jumlah ditahan.",
    zh: "请注明扣留每笔金额的原因。",
  },
  "Say why it is being voided.": {
    ms: "Nyatakan sebab ia dibatalkan.",
    zh: "请注明作废原因。",
  },
  "Say why it is hidden.": {
    ms: "Nyatakan sebab ia disembunyikan.",
    zh: "请注明隐藏原因。",
  },
  "Say why they are disqualified: it is kept with the record.": {
    ms: "Nyatakan sebab mereka hilang kelayakan: ia disimpan bersama rekod.",
    zh: "请注明取消资格的原因：原因会与记录一并保存。",
  },
  "Say why: a correction after the knockout has begun is kept with its reason.": {
    ms: "Nyatakan sebab: pembetulan selepas kalah mati bermula disimpan bersama sebabnya.",
    zh: "请注明原因：淘汰赛开始后的更正会连同原因一并保存。",
  },
  "Say why: how it was resolved is kept with its reason.": {
    ms: "Nyatakan sebab: cara ia diselesaikan disimpan bersama sebabnya.",
    zh: "请注明原因：处理方式会连同原因一并保存。",
  },
  "Say why: their staff are told.": {
    ms: "Nyatakan sebab: kakitangan mereka akan dimaklumkan.",
    zh: "请注明原因：对方员工会收到通知。",
  },
  "Scoring is a set of choices.": {
    ms: "Pemarkahan ialah satu set pilihan.",
    zh: "计分方式须为一组选项。",
  },
  "Search by email or phone.": {
    ms: "Cari melalui e-mel atau telefon.",
    zh: "请按电邮或电话搜索。",
  },
  "Send a photo as JPEG, PNG or WebP.": {
    ms: "Hantar foto dalam format JPEG, PNG atau WebP.",
    zh: "请上传 JPEG、PNG 或 WebP 格式的照片。",
  },
  "Send the photo as a form upload.": {
    ms: "Hantar foto sebagai muat naik borang.",
    zh: "请通过表单上传照片。",
  },
  "Series not found.": {
    ms: "Siri tidak dijumpai.",
    zh: "找不到该系列。",
  },
  "Set up taking payment online first: there is no way to pay without it.": {
    ms: "Sediakan pembayaran dalam talian dahulu: tanpanya tiada cara untuk membayar.",
    zh: "请先设置在线收款：否则无法付款。",
  },
  "Set up two-factor sign-in for this account first.": {
    ms: "Sediakan log masuk dua faktor untuk akaun ini dahulu.",
    zh: "请先为此账户设置双重验证登录。",
  },
  "Sign in first.": {
    ms: "Log masuk dahulu.",
    zh: "请先登录。",
  },
  "Sign-off not found.": {
    ms: "Pengesahan tidak dijumpai.",
    zh: "找不到资格确认记录。",
  },
  "Signing in with Google is not set up here.": {
    ms: "Log masuk dengan Google belum disediakan di sini.",
    zh: "此处尚未设置 Google 登录。",
  },
  "Some kit is still out on hire. Take it back in first.": {
    ms: "Sesetengah peralatan masih disewa. Terima kembali dahulu.",
    zh: "仍有装备在出租中。请先收回。",
  },
  "Somebody given is not in it.": {
    ms: "Seseorang yang diberikan tiada di dalamnya.",
    zh: "所列人员中有人不在其中。",
  },
  "Something hired out against a deposit needs someone at the counter, so it cannot be unmanned.": {
    ms: "Barang yang disewa dengan deposit memerlukan seseorang di kaunter, jadi ia tidak boleh tanpa penjaga.",
    zh: "凭押金出租的物品需要有人在柜台，因此不能设为无人值守。",
  },
  "Staff work at one branch, or manage the whole business — not both.": {
    ms: "Kakitangan bekerja di satu cawangan, atau mengurus seluruh perniagaan — bukan kedua-duanya.",
    zh: "员工只能在一家分店工作，或管理整个企业——不能两者兼任。",
  },
  "Start again: scan the new code first.": {
    ms: "Mula semula: imbas kod baharu dahulu.",
    zh: "请重新开始：先扫描新的二维码。",
  },
  "Start it today or later.": {
    ms: "Mulakan hari ini atau kemudian.",
    zh: "须从今天或之后开始。",
  },
  "Start today or later.": {
    ms: "Mula hari ini atau kemudian.",
    zh: "须从今天或之后开始。",
  },
  "Steps are whole minutes, 1 to 1440.": {
    ms: "Langkah ialah minit penuh, 1 hingga 1440.",
    zh: "间隔须为整分钟，1 至 1440。",
  },
  "Storefront not found.": {
    ms: "Laman web jenama tidak dijumpai.",
    zh: "找不到品牌网站。",
  },
  "Strikes before paying online: 1 to 20, or off.": {
    ms: "Kesalahan sebelum perlu bayar dalam talian: 1 hingga 20, atau matikan.",
    zh: "须在线付款前允许的违规次数：1 至 20，或关闭。",
  },
  "Stripe has no payment on that page to refund.": {
    ms: "Stripe tiada bayaran pada halaman itu untuk dibayar balik.",
    zh: "Stripe 在该页面上没有可退款的付款。",
  },
  "Take 0 to 50 percent off for the whole term.": {
    ms: "Beri diskaun 0 hingga 50 peratus untuk sepanjang penggal.",
    zh: "整期报名优惠 0% 至 50%。",
  },
  "Take 5 to 100 percent off.": {
    ms: "Beri diskaun 5 hingga 100 peratus.",
    zh: "优惠 5% 至 100%。",
  },
  "Tell the venue a little about what you have in mind.": {
    ms: "Ceritakan sedikit kepada pusat tentang apa yang anda rancang.",
    zh: "请简单告诉场馆您的想法。",
  },
  "That API key is not valid, or was revoked.": {
    ms: "Kunci API itu tidak sah, atau telah dibatalkan.",
    zh: "该 API 密钥无效或已被撤销。",
  },
  "That access is already withdrawn.": {
    ms: "Akses itu sudah ditarik balik.",
    zh: "该访问权限已被撤回。",
  },
  "That account cannot be charged here.": {
    ms: "Akaun itu tidak boleh dicaj di sini.",
    zh: "此处不能向该账户收费。",
  },
  "That account is not open here.": {
    ms: "Akaun itu tidak dibuka di sini.",
    zh: "该账户未在此处开设。",
  },
  "That account is not part of your business.": {
    ms: "Akaun itu bukan sebahagian daripada perniagaan anda.",
    zh: "该账户不属于贵企业。",
  },
  "That application has already been decided.": {
    ms: "Permohonan itu telah diputuskan.",
    zh: "该申请已有决定。",
  },
  "That booking does not repeat. Book the court weekly first, then make it a weekly game.": {
    ms: "Tempahan itu tidak berulang. Tempah gelanggang setiap minggu dahulu, kemudian jadikannya permainan mingguan.",
    zh: "该预订不是重复预订。请先每周预订场地，再设为每周球局。",
  },
  "That booking has already started.": {
    ms: "Tempahan itu sudah bermula.",
    zh: "该预订已开始。",
  },
  "That booking has started.": {
    ms: "Tempahan itu telah bermula.",
    zh: "该预订已开始。",
  },
  "That booking has started: settle up with the booker.": {
    ms: "Tempahan itu telah bermula: selesaikan dengan penempah.",
    zh: "该预订已开始：请与预订人自行结算。",
  },
  "That booking is already on that court.": {
    ms: "Tempahan itu sudah berada di gelanggang itu.",
    zh: "该预订已在该场地。",
  },
  "That booking is already open to other players.": {
    ms: "Tempahan itu sudah dibuka kepada pemain lain.",
    zh: "该预订已向其他球员开放。",
  },
  "That booking is cancelled.": {
    ms: "Tempahan itu telah dibatalkan.",
    zh: "该预订已取消。",
  },
  "That booking is paid already.": {
    ms: "Tempahan itu sudah dibayar.",
    zh: "该预订已付款。",
  },
  "That booking is paid in full: settle up with the booker.": {
    ms: "Tempahan itu telah dibayar penuh: selesaikan dengan penempah.",
    zh: "该预订已全额付款：请与预订人自行结算。",
  },
  "That booking was cancelled.": {
    ms: "Tempahan itu sudah dibatalkan.",
    zh: "该预订已被取消。",
  },
  "That business is not suspended.": {
    ms: "Perniagaan itu tidak digantung.",
    zh: "该企业未被暂停。",
  },
  "That cannot be called off now.": {
    ms: "Itu tidak boleh dibatalkan sekarang.",
    zh: "现在无法取消。",
  },
  "That coach does not give lessons in this sport here.": {
    ms: "Jurulatih itu tidak mengajar sukan ini di sini.",
    zh: "该教练在此不教授这项运动。",
  },
  "That coach does not take lessons here.": {
    ms: "Jurulatih itu tidak menerima tempahan kelas di sini.",
    zh: "该教练在此不接受课程预订。",
  },
  "That code has run out. Ask for a new one.": {
    ms: "Kod itu telah tamat tempoh. Minta kod baharu.",
    zh: "该验证码已过期。请索取新的验证码。",
  },
  "That code is not right.": {
    ms: "Kod itu tidak betul.",
    zh: "验证码不正确。",
  },
  "That code is not right. Check the phone's clock, and type the six digits showing now.": {
    ms: "Kod itu tidak betul. Semak jam telefon, dan taip enam digit yang dipaparkan sekarang.",
    zh: "验证码不正确。请检查手机时间，并输入当前显示的六位数字。",
  },
  "That code is not valid at this venue.": {
    ms: "Kod itu tidak sah di pusat ini.",
    zh: "该代码在本场馆无效。",
  },
  "That colour is too light for white writing on buttons to be readable. Pick a darker shade.": {
    ms: "Warna itu terlalu cerah untuk tulisan putih pada butang dibaca dengan jelas. Pilih warna yang lebih gelap.",
    zh: "该颜色太浅，按钮上的白色文字难以看清。请选择更深的颜色。",
  },
  "That competition has started: divisions are added before it.": {
    ms: "Pertandingan itu telah bermula: bahagian ditambah sebelum ia bermula.",
    zh: "该赛事已开始：组别须在开始前添加。",
  },
  "That competition is at another venue.": {
    ms: "Pertandingan itu di pusat lain.",
    zh: "该赛事在其他场馆举行。",
  },
  "That competition is not taking divisions.": {
    ms: "Pertandingan itu tidak menerima bahagian baharu.",
    zh: "该赛事不接受新增组别。",
  },
  "That concession is not offered here.": {
    ms: "Konsesi itu tidak ditawarkan di sini.",
    zh: "此处不提供该优惠价。",
  },
  "That court is not at this key's venue.": {
    ms: "Gelanggang itu bukan di pusat kunci ini.",
    zh: "该场地不属于此密钥的场馆。",
  },
  "That date has passed.": {
    ms: "Tarikh itu telah berlalu.",
    zh: "该日期已过。",
  },
  "That day is not closed.": {
    ms: "Hari itu tidak ditutup.",
    zh: "该日不是休息日。",
  },
  "That email address does not look right.": {
    ms: "Alamat e-mel itu nampaknya tidak betul.",
    zh: "该电邮地址似乎不正确。",
  },
  "That email already has an account. Sign in at /admin.": {
    ms: "E-mel itu sudah mempunyai akaun. Log masuk di /admin.",
    zh: "该电邮已有账户。请在 /admin 登录。",
  },
  "That email has an account already. Reject this one and add them by hand.": {
    ms: "E-mel itu sudah mempunyai akaun. Tolak permohonan ini dan tambah mereka secara manual.",
    zh: "该电邮已有账户。请拒绝此申请，并手动添加对方。",
  },
  "That entry is not in.": {
    ms: "Penyertaan itu tiada dalam pertandingan.",
    zh: "该报名不在此赛事中。",
  },
  "That file could not be read as a photo.": {
    ms: "Fail itu tidak dapat dibaca sebagai foto.",
    zh: "无法将该文件读取为照片。",
  },
  "That game has started.": {
    ms: "Permainan itu telah bermula.",
    zh: "该球局已开始。",
  },
  "That game is already called off.": {
    ms: "Permainan itu sudah dibatalkan.",
    zh: "该球局已取消。",
  },
  "That game is closed.": {
    ms: "Permainan itu ditutup.",
    zh: "该球局已关闭。",
  },
  "That game is full.": {
    ms: "Permainan itu penuh.",
    zh: "该球局已满。",
  },
  "That game is not open.": {
    ms: "Permainan itu tidak dibuka.",
    zh: "该球局未开放。",
  },
  "That game is not taking players.": {
    ms: "Permainan itu tidak menerima pemain.",
    zh: "该球局不接受球员加入。",
  },
  "That game is not there any more.": {
    ms: "Permainan itu sudah tiada.",
    zh: "该球局已不存在。",
  },
  "That game is off.": {
    ms: "Permainan itu dibatalkan.",
    zh: "该球局已取消。",
  },
  "That group is not taking members.": {
    ms: "Kumpulan itu tidak menerima ahli.",
    zh: "该群组不接受新成员。",
  },
  "That group is not there any more.": {
    ms: "Kumpulan itu sudah tiada.",
    zh: "该群组已不存在。",
  },
  "That has been answered already.": {
    ms: "Itu sudah dijawab.",
    zh: "已回复。",
  },
  "That has been resolved.": {
    ms: "Itu telah diselesaikan.",
    zh: "已处理。",
  },
  "That invoice is not here, or is paid already.": {
    ms: "Invois itu tiada di sini, atau sudah dibayar.",
    zh: "该发票不在此处，或已付款。",
  },
  "That invoice is not waiting to be paid.": {
    ms: "Invois itu tidak menunggu bayaran.",
    zh: "该发票不在待付款状态。",
  },
  "That invoice is not yours to pay.": {
    ms: "Invois itu bukan untuk anda bayar.",
    zh: "该发票不由您支付。",
  },
  "That is a bye.": {
    ms: "Itu ialah bye.",
    zh: "该轮为轮空。",
  },
  "That is a few codes already. Try again in an hour.": {
    ms: "Sudah beberapa kod dihantar. Cuba lagi dalam sejam.",
    zh: "已发送多次验证码。请一小时后再试。",
  },
  "That is a few tries already. Try again in an hour.": {
    ms: "Sudah beberapa kali cubaan. Cuba lagi dalam sejam.",
    zh: "已尝试多次。请一小时后再试。",
  },
  "That is already closed.": {
    ms: "Itu sudah ditutup.",
    zh: "已关闭。",
  },
  "That is not a heat or a final.": {
    ms: "Itu bukan saringan atau final.",
    zh: "这不是预赛或决赛。",
  },
  "That is not a phone number.": {
    ms: "Itu bukan nombor telefon.",
    zh: "这不是电话号码。",
  },
  "That is not a place we can use.": {
    ms: "Itu bukan lokasi yang boleh kami gunakan.",
    zh: "无法使用该地点。",
  },
  "That is not an amount.": {
    ms: "Itu bukan jumlah.",
    zh: "这不是有效金额。",
  },
  "That is not one of your bookings.": {
    ms: "Itu bukan salah satu tempahan anda.",
    zh: "这不是您的预订。",
  },
  "That is not the code. Check it and try again.": {
    ms: "Itu bukan kodnya. Semak dan cuba lagi.",
    zh: "验证码不对。请检查后重试。",
  },
};
