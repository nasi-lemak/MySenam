# WhatsApp set-up and templates

The WhatsApp Cloud API set-up and every template to submit to Meta, word for word in each language. `tests/transports.test.ts` checks that each template the code sends appears here exactly.

## Setting up WhatsApp

WhatsApp only lets a business start a conversation with a **template Meta has
approved**. Each kind of message is one template, written from the same phrase
the email is, and what fills it is sent as its parameters.

1. In [Meta for Developers](https://developers.facebook.com/), create an app
   with the WhatsApp product, add the venue's number, and create a permanent
   access token for a system user. Its token is `WHATSAPP_TOKEN`; the number's
   *Phone number ID* is `WHATSAPP_PHONE_NUMBER_ID`.
2. In WhatsApp Manager, create the templates below, category **Utility**,
   each with an English (`en`), a Malay (`ms`), a Chinese (`zh_CN`) and a Tamil (`ta`) translation, the body exactly
   as given. The name must match, prefix included.
3. Wait for approval, then set the two variables. Anything that failed while
   waiting can be retried from the dashboard.

If the wording of a message changes, the template has to be resubmitted: the
test suite fails when this README and the code disagree, and the text below is
what to paste.

### `mysenam_booking_confirmed`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} total, {{6}} link

```text
Hi {{1}}, your booking is confirmed.

Code: {{2}}
{{3}}
{{4}}
Total: {{5}}

Show the code at the front desk. To see, pay or cancel it, open {{6}} and enter the code.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} total, {{6}} link

```text
Hai {{1}}, tempahan anda telah disahkan.

Kod: {{2}}
{{3}}
{{4}}
Jumlah: {{5}}

Tunjukkan kod ini di kaunter hadapan. Untuk melihat, membayar atau membatalkannya, buka {{6}} dan masukkan kod ini.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} total, {{6}} link

```text
您好，{{1}}！您的预订已确认。

代码：{{2}}
{{3}}
{{4}}
总额：{{5}}

请在前台出示代码。如需查看、付款或取消，请打开 {{6}} 并输入代码。
```

Tamil (`ta`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} total, {{6}} link

```text
வணக்கம் {{1}}, உங்கள் முன்பதிவு உறுதியானது.

குறியீடு: {{2}}
{{3}}
{{4}}
மொத்தம்: {{5}}

முன் மேசையில் குறியீட்டைக் காட்டுங்கள். அதைப் பார்க்க, செலுத்த அல்லது ரத்து செய்ய, {{6}} ஐத் திறந்து குறியீட்டை உள்ளிடுங்கள்.
```

### `mysenam_booking_series_confirmed`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} weeks, {{5}} when, {{6}} total, {{7}} link

```text
Hi {{1}}, your weekly sessions are booked.

Series code: {{2}}
{{3}}
{{4}} weeks from {{5}}
Total: {{6}}

Show the code at the front desk. To see, pay or cancel, open {{7}} and enter the series code.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} weeks, {{5}} when, {{6}} total, {{7}} link

```text
Hai {{1}}, sesi mingguan anda telah ditempah.

Kod siri: {{2}}
{{3}}
{{4}} minggu bermula {{5}}
Jumlah: {{6}}

Tunjukkan kod ini di kaunter hadapan. Untuk melihat, membayar atau membatalkan, buka {{7}} dan masukkan kod siri.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} weeks, {{6}} total, {{7}} link

```text
您好，{{1}}！您的每周时段已预订。

系列代码：{{2}}
{{3}}
自 {{4}} 起，共 {{5}} 周
总额：{{6}}

请在前台出示代码。如需查看、付款或取消，请打开 {{7}} 并输入系列代码。
```

Tamil (`ta`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} weeks, {{6}} total, {{7}} link

```text
வணக்கம் {{1}}, உங்கள் வாராந்திர அமர்வுகள் முன்பதிவு செய்யப்பட்டன.

தொடர் குறியீடு: {{2}}
{{3}}
{{4}} முதல் {{5}} வாரங்கள்
மொத்தம்: {{6}}

முன் மேசையில் குறியீட்டைக் காட்டுங்கள். பார்க்க, செலுத்த அல்லது ரத்து செய்ய, {{7}} ஐத் திறந்து தொடர் குறியீட்டை உள்ளிடுங்கள்.
```

### `mysenam_booking_cancelled`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} money

```text
Hi {{1}}, booking {{2}} has been cancelled.

{{3}}
{{4}}

The slot is free again.
{{5}}

See you another time.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} money

```text
Hai {{1}}, tempahan {{2}} telah dibatalkan.

{{3}}
{{4}}

Waktu itu kosong semula.
{{5}}

Jumpa lagi.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} money

```text
您好，{{1}}！预订 {{2}} 已取消。

{{3}}
{{4}}

该时段已重新开放。
{{5}}

期待下次再见。
```

Tamil (`ta`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} money

```text
வணக்கம் {{1}}, முன்பதிவு {{2}} ரத்து செய்யப்பட்டது.

{{3}}
{{4}}

அந்த நேரம் மீண்டும் காலியாக உள்ளது.
{{5}}

மற்றொரு முறை சந்திப்போம்.
```

### `mysenam_waitlist_offer`

English (`en`) — {{1}} name, {{2}} what, {{3}} venue, {{4}} date, {{5}} from, {{6}} link

```text
Hi {{1}}, a place has opened up for {{2}} at {{3}}, {{4}} {{5}}.

It is held for you for 30 minutes, and then goes to the next person waiting. Claim it at {{6}} while it is yours.
```

Malay (`ms`) — {{1}} name, {{2}} what, {{3}} venue, {{4}} date, {{5}} from, {{6}} link

```text
Hai {{1}}, ada tempat kosong untuk {{2}} di {{3}}, {{4}} {{5}}.

Ia ditahan untuk anda selama 30 minit, kemudian diberikan kepada orang seterusnya dalam giliran. Tuntut di {{6}} selagi ia milik anda.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} venue, {{3}} what, {{4}} date, {{5}} from, {{6}} link

```text
您好，{{1}}！{{2}} 的 {{3}}（{{4}} {{5}}）有名额空出。

名额会为您保留 30 分钟，之后将转给下一位候补者。请趁名额仍属于您时在 {{6}} 领取。
```

Tamil (`ta`) — {{1}} name, {{2}} venue, {{3}} date, {{4}} from, {{5}} what, {{6}} link

```text
வணக்கம் {{1}}, {{2}} இல் {{3}} {{4}} அன்று {{5}} க்கு ஓர் இடம் காலியாகியுள்ளது.

அது உங்களுக்காக 30 நிமிடங்கள் ஒதுக்கப்பட்டிருக்கும், பின்னர் காத்திருக்கும் அடுத்தவருக்குச் செல்லும். அது உங்களுடையதாக இருக்கும்போதே {{6}} இல் அதைப் பெற்றுக்கொள்ளுங்கள்.
```

### `mysenam_class_enrolled`

English (`en`) — {{1}} name, {{2}} what, {{3}} instructor, {{4}} code, {{5}} venue, {{6}} when, {{7}} total

```text
Hi {{1}}, you are enrolled in {{2}} with {{3}}.

Code: {{4}}
{{5}}
{{6}}
Total: {{7}}

Show the code at the front desk.
```

Malay (`ms`) — {{1}} name, {{2}} what, {{3}} instructor, {{4}} code, {{5}} venue, {{6}} when, {{7}} total

```text
Hai {{1}}, anda telah berdaftar dalam {{2}} bersama {{3}}.

Kod: {{4}}
{{5}}
{{6}}
Jumlah: {{7}}

Tunjukkan kod ini di kaunter hadapan.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} instructor, {{3}} what, {{4}} code, {{5}} venue, {{6}} when, {{7}} total

```text
您好，{{1}}！您已报名由 {{2}} 指导的 {{3}}。

代码：{{4}}
{{5}}
{{6}}
总额：{{7}}

请在前台出示代码。
```

Tamil (`ta`) — {{1}} name, {{2}} instructor, {{3}} what, {{4}} code, {{5}} venue, {{6}} when, {{7}} total

```text
வணக்கம் {{1}}, {{2}} உடன் {{3}} இல் நீங்கள் சேர்ந்துவிட்டீர்கள்.

குறியீடு: {{4}}
{{5}}
{{6}}
மொத்தம்: {{7}}

முன் மேசையில் குறியீட்டைக் காட்டுங்கள்.
```

### `mysenam_booking_cancelled_by_venue`

When the venue gives a reason (a [rain-out](../features/booking.md#rained-off)),
{{6}} carries it before what is owed, as *Reason: Rained off · Anything you
paid will be refunded by the venue.*, in the customer's language; the template
itself is the same.

English (`en`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hi {{1}}, we are sorry: {{2}} has had to cancel booking {{3}}.

{{4}}
{{5}}
{{6}}

Please tap {{7}} to let them know you have seen this.
```

Malay (`ms`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hai {{1}}, kami memohon maaf: {{2}} terpaksa membatalkan tempahan {{3}}.

{{4}}
{{5}}
{{6}}

Sila tekan {{7}} untuk memberitahu mereka anda telah melihat mesej ini.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
您好，{{1}}！很抱歉：{{2}} 不得不取消预订 {{3}}。

{{4}}
{{5}}
{{6}}

请点击 {{7}} 告知对方您已看到此消息。
```

Tamil (`ta`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
வணக்கம் {{1}}, மன்னிக்கவும்: {{2}} முன்பதிவு {{3}} ஐ ரத்து செய்ய வேண்டியதாயிற்று.

{{4}}
{{5}}
{{6}}

நீங்கள் இதைப் பார்த்துவிட்டீர்கள் என்று அவர்களுக்குத் தெரிவிக்க {{7}} ஐத் தட்டுங்கள்.
```

### `mysenam_booking_moved`

English (`en`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} ack

```text
Hi {{1}}, {{2}} has moved booking {{3}} to another court.

Now: {{4}}
{{5}}

Same time, same price. Please tap {{6}} to let them know you have seen this.
```

Malay (`ms`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} ack

```text
Hai {{1}}, {{2}} telah memindahkan tempahan {{3}} ke gelanggang lain.

Kini: {{4}}
{{5}}

Masa dan harga yang sama. Sila tekan {{6}} untuk memberitahu mereka anda telah melihat mesej ini.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} ack

```text
您好，{{1}}！{{2}} 已将预订 {{3}} 调到另一个场地。

现为：{{4}}
{{5}}

时间不变，价格不变。请点击 {{6}} 告知对方您已看到此消息。
```

Tamil (`ta`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} ack

```text
வணக்கம் {{1}}, {{2}} முன்பதிவு {{3}} ஐ வேறொரு கோர்ட்டுக்கு மாற்றியுள்ளது.

இப்போது: {{4}}
{{5}}

அதே நேரம், அதே விலை. நீங்கள் இதைப் பார்த்துவிட்டீர்கள் என்று அவர்களுக்குத் தெரிவிக்க {{6}} ஐத் தட்டுங்கள்.
```

### `mysenam_booking_rescheduled`

Sent when staff change a booking's date or time (a customer who changes their own is emailed instead).

English (`en`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hi {{1}}, {{2}} has changed the time of booking {{3}}.

Now: {{4}}
{{5}}
{{6}}

Please tap {{7}} to let them know you have seen this.
```

Malay (`ms`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
Hai {{1}}, {{2}} telah menukar masa tempahan {{3}}.

Kini: {{4}}
{{5}}
{{6}}

Sila tekan {{7}} untuk memberitahu mereka anda telah melihat mesej ini.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
您好，{{1}}！{{2}} 已更改预订 {{3}} 的时间。

现为：{{4}}
{{5}}
{{6}}

请点击 {{7}} 告知对方您已看到此消息。
```

Tamil (`ta`) — {{1}} name, {{2}} venue, {{3}} code, {{4}} where, {{5}} when, {{6}} money, {{7}} ack

```text
வணக்கம் {{1}}, {{2}} முன்பதிவு {{3}} இன் நேரத்தை மாற்றியுள்ளது.

இப்போது: {{4}}
{{5}}
{{6}}

நீங்கள் இதைப் பார்த்துவிட்டீர்கள் என்று அவர்களுக்குத் தெரிவிக்க {{7}} ஐத் தட்டுங்கள்.
```

### `mysenam_booking_reminder`

English (`en`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} link

```text
Hi {{1}}, a reminder of your booking.

Code: {{2}}
{{3}}
{{4}}

Cannot make it? Cancel at {{5}} so somebody else can play.
```

Malay (`ms`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} link

```text
Hai {{1}}, peringatan tentang tempahan anda.

Kod: {{2}}
{{3}}
{{4}}

Tidak dapat hadir? Batalkan di {{5}} supaya orang lain boleh bermain.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} link

```text
您好，{{1}}！提醒您有一个预订。

代码：{{2}}
{{3}}
{{4}}

无法前来？请在 {{5}} 取消，让其他人可以打球。
```

Tamil (`ta`) — {{1}} name, {{2}} code, {{3}} where, {{4}} when, {{5}} link

```text
வணக்கம் {{1}}, உங்கள் முன்பதிவுக்கான நினைவூட்டல்.

குறியீடு: {{2}}
{{3}}
{{4}}

வர முடியவில்லையா? வேறொருவர் விளையாடும்படி {{5}} இல் ரத்து செய்யுங்கள்.
```

### `mysenam_venue_new_booking`

To the venue itself, at the number it chose under *Venue details → New-booking alerts*.

English (`en`) — {{1}} name, {{2}} phone, {{3}} where, {{4}} when, {{5}} code, {{6}} amount, {{7}} paid

```text
New booking.

{{1}}, {{2}}
{{3}}
{{4}}

Code {{5}}, {{6}}, {{7}}. It is on your Bookings list.
```

Malay (`ms`) — {{1}} name, {{2}} phone, {{3}} where, {{4}} when, {{5}} code, {{6}} amount, {{7}} paid

```text
Tempahan baharu.

{{1}}, {{2}}
{{3}}
{{4}}

Kod {{5}}, {{6}}, {{7}}. Ia ada dalam senarai Tempahan anda.
```

Chinese (`zh_CN`) — {{1}} name, {{2}} phone, {{3}} where, {{4}} when, {{5}} code, {{6}} amount, {{7}} paid

```text
新预订。

{{1}}，{{2}}
{{3}}
{{4}}

代码 {{5}}，{{6}}，{{7}}。已列入您的预订列表。
```

Tamil (`ta`) — {{1}} name, {{2}} phone, {{3}} where, {{4}} when, {{5}} code, {{6}} amount, {{7}} paid

```text
புதிய முன்பதிவு.

{{1}}, {{2}}
{{3}}
{{4}}

குறியீடு {{5}}, {{6}}, {{7}}. இது உங்கள் முன்பதிவுகள் பட்டியலில் உள்ளது.
```
