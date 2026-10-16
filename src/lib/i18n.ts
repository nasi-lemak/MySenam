/**
 * Two languages, one dictionary.
 *
 * MySenam is used in Malaysia by people who are not all comfortable in
 * English, so the customer-facing side speaks Bahasa Malaysia as well. The
 * choice lives in a cookie rather than the URL: this is an application people
 * come to in order to book, not a site they arrive at from a search engine,
 * and a `/ms` prefix on every route would have been a large amount of routing
 * for very little.
 *
 * English is the source text and Bahasa Malaysia is typed against it, so a
 * phrase added on one side and forgotten on the other does not compile. That
 * is the whole point of the shape below — "is it all translated?" should be a
 * question the build answers, not one somebody has to go and check.
 */

import { siteName } from "./site";

export const LOCALES = ["en", "ms"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "ms_lang";

/** What each language calls itself — never translated. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ms: "Bahasa Malaysia",
};

/**
 * The BCP-47 tag for date and time formatting.
 *
 * Intl already knows the Malay weekday and month names, so a date does not
 * belong in the dictionary — it belongs in the right locale tag.
 */
export const INTL_TAGS: Record<Locale, string> = {
  en: "en-MY",
  ms: "ms-MY",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "en" || value === "ms";
}

/**
 * The English text, which is also the set of keys.
 *
 * `{name}` is a placeholder filled at the call site. A key ending `_one` must
 * have an `_other` beside it: English counts, Bahasa Malaysia does not, and
 * `plural()` below is what hides the difference.
 */
const EN = {
  // Shell
  "meta.title": "{site} — Book Courts, Gyms & Classes Online",
  "meta.description":
    "Book badminton, tennis, pickleball and futsal courts, gym sessions and classes across the Klang Valley in seconds.",
  "nav.venues": "Venues",
  "nav.find": "Find a court",
  "nav.classes": "Classes",
  "nav.myBooking": "My Booking",
  "nav.admin": "Admin",
  "nav.signIn": "Sign in",
  "footer.tagline":
    "{site} — gelanggang, gim dan kelas, satu tempahan. Built for badminton, tennis, pickleball, futsal, gym & swimming.",
  "footer.privacy": "Privacy notice",
  "lang.label": "Language",

  // Home
  "home.heroTitle": "Book a court in seconds.",
  "home.heroBody":
    "Badminton, tennis, pickleball and futsal — see live availability, pick your slots and get a booking code instantly. No calls, no waiting. Mudah je!",
  "home.heroCta": "Find a court by time",
  "home.venuesTitle": "Venues",
  "home.venuesIntro": "Choose a venue to see live court availability, or",
  "home.venuesSearchLink": "search every venue at once",
  "home.courts_one": "{n} court",
  "home.courts_other": "{n} courts",
  "home.fromRate": "from RM{rate}/hr",
  "home.step1Title": "1. Pick a slot",
  "home.step1Body": "Choose venue, date and court — availability is live.",
  "home.step2Title": "2. Confirm",
  "home.step2Body": "Enter your name and phone. Pay at the counter when you arrive.",
  "home.step3Title": "3. Play",
  "home.step3Body": "You get a booking code instantly. Show it at the front desk.",

  // Sports. The English is what SPORT_LABELS says; this is the same list in
  // both languages, so a customer sees one vocabulary throughout.
  "sport.badminton": "Badminton",
  "sport.tennis": "Tennis",
  "sport.pickleball": "Pickleball",
  "sport.futsal": "Futsal",
  "sport.gym": "Gym",
  "sport.swimming": "Swimming",
  "sport.kayak": "Kayak hire",

  // Venue
  "venue.openDaily": "Open daily {from} – {to}",
  "venue.freeCancel_one": "free cancellation until {n} hour before your slot",
  "venue.freeCancel_other": "free cancellation until {n} hours before your slot",
  "venue.cancelAnyTime": "cancel any time before your slot starts",
  "venue.closures": "Upcoming closures:",

  // Sign in / register
  "auth.welcomeBack": "Welcome back",
  "auth.createAccount": "Create an account",
  "auth.signInIntro": "Sign in to see and manage your bookings.",
  "auth.registerIntro": "Register to keep all your bookings in one place.",
  "auth.signIn": "Sign in",
  "auth.register": "Register",
  "auth.name": "Name",
  "auth.namePlaceholder": "Ali bin Abu",
  "auth.phone": "Phone",
  "auth.phonePlaceholder": "012-345 6789",
  "auth.email": "Email",
  "auth.emailPlaceholder": "you@example.com",
  "auth.password": "Password",
  "auth.passwordHint": "At least 8 characters",
  "auth.creating": "Create account",
  "auth.working": "Please wait…",
  "auth.failed": "Something went wrong",

  // Check-in
  "checkin.working": "Checking you in…",
  "checkin.doneTitle": "You're checked in",
  "checkin.doneBody": "Enjoy your session, {name}.",
  "checkin.venue": "Venue",
  "checkin.facility": "Facility",
  "checkin.time": "Time",
  "checkin.code": "Code",
  "checkin.failedTitle": "Couldn't check you in",
  "checkin.failed": "Check-in failed",
  "checkin.tryAgain": "Try again",
  "checkin.stuck": "Still stuck? The front desk can check you in manually.",
  "checkin.back": "Back to {site}",

  // Claiming a waitlist place
  "claim.yoursTitle": "The place is yours",
  "claim.with": "{name} with {instructor}",
  "claim.payable": "RM{amount}, payable at the counter.",
  "claim.goneTitle": "Offer unavailable",
  "claim.goneBody":
    "Places are offered in turn and held for a short while. If yours ran out, you can join the waitlist again.",
  "claim.openTitle": "A place opened up",
  "claim.openBody":
    "Someone cancelled and you are next in the queue. Claim it before the hold runs out.",
  "claim.button": "Claim my place",
  "claim.working": "Claiming…",
  "claim.failed": "Could not claim the place",
  "claim.back": "Back to classes",

  // How busy it is
  "live.title": "Here right now",
  "live.updated": "live · updated {time}",
  "live.inside": "{present}/{capacity} in",
  "live.source": "Counted from check-ins at the front desk.",
  "busy.quiet": "Quiet",
  "busy.filling": "Filling up",
  "busy.busy": "Busy",
  "busy.full": "Full",

  // Booking board
  "board.loadFailed": "Failed to load availability",
  "board.closed": "Closed on {date}.",
  "board.pickAnother": "Pick another date.",
  "board.memberTitle": "Member prices.",
  "board.memberBody": "You are a member here, so the rates below are yours.",
  "board.loading": "Loading availability…",
  "board.court": "Court",
  "board.anyCourt": "Any court",
  "board.anyCourtHint": "cheapest free one",
  "board.places": "{n} places",
  "board.depositLine": "RM{amount} deposit",
  "board.anyFree_one": "{time} · from RM{rate} · {n} court free",
  "board.anyFree_other": "{time} · from RM{rate} · {n} courts free",
  "board.anyNone": "No court free this hour",
  "board.queueHint": "Taken — click to join the waitlist",
  "board.reservedFor": "Reserved for {name}",
  "board.unavailable": "Unavailable",
  "board.sharedSlot": "{time} · RM{rate} · {left} of {capacity} places left ({level})",
  "board.plainSlot": "{time} · RM{rate}",
  "board.legendFree": "Available (number = RM/hr)",
  "board.legendShared": "Shared facility (number = places left)",
  "board.legendSelected": "Selected",
  "board.legendTaken": "Booked / past",
  "board.maxHours": "Max {n} consecutive hours per booking",
  "board.noCourts": "No {sport} courts at this venue.",

  // The booking bar
  "form.depositNote":
    "Plus an RM{amount} deposit at the counter, back in your hand when the kit is.",
  "form.name": "Name",
  "form.phone": "Phone",
  "form.emailOptional": "Email (optional)",
  "form.repeat": "Repeat",
  "form.justOnce": "Just once",
  "form.weekly": "Weekly × {n}",
  "form.booking": "Booking…",
  "form.bookWeeks": "Book {weeks} weeks · RM{amount}/wk",
  "form.book": "Book · RM{amount}",
  "form.payFromCredit": "Pay from my credit balance (RM{amount} available)",
  "form.promoLabel": "Promo code?",
  "form.promoChecked": "Checked when you book; the total updates then.",
  "form.passLabel": "Using a pass?",
  "form.passNone": "No — pay at the counter",
  "form.passOption": "{name} · {n} left",
  "form.passSpend_one": "Spends {n} entry{per}.",
  "form.passSpend_other": "Spends {n} entries{per}.",
  "form.passPerWeek": " per week ({total} in total)",
  "form.skipTaken":
    "Skip weeks that are already taken (otherwise the whole series is rejected on any clash)",
  "form.failed": "Booking failed",

  // Confirmation
  "done.seriesTitle": "{n} weekly sessions booked!",
  "done.title": "Booking confirmed!",
  "done.body":
    "Show this code at the counter. Save it — you'll need it (with your phone number) to view or cancel {what}.",
  "done.theSeries": "the series",
  "done.theBooking": "the booking",
  "done.venue": "Venue",
  "done.court": "Court",
  "done.date": "Date",
  "done.time": "Time",
  "done.promoDiscount": "Promo discount",
  "done.total": "Total",
  "done.totalValue": "RM{amount} (pay at counter)",
  "done.deposit": "Deposit",
  "done.depositValue": "RM{amount}, returned with the kit",
  "done.promoRejected": "Your promo code was not applied: {reason}",
  "done.sessions": "Sessions",
  "done.skipped": "skipped — {reason}",
  "done.icsFile": ".ics file",
  "done.close": "Done",

  // Joining a waitlist for a slot
  "queue.onTitle": "You're on the waitlist",
  "queue.onBody": "Number {position} for {court} at {time}.",
  "queue.onNote":
    "If it frees up, the slot is offered to whoever has waited longest. Signed-in customers see the offer on their account page.",
  "queue.taken":
    "This slot is taken. Join the waitlist and we'll offer it to you if it frees up.",
  "queue.cancel": "Cancel",
  "queue.join": "Join waitlist",
  "queue.joining": "Joining…",
  "queue.failed": "Could not join the waitlist",

  // Search
  "search.title": "Find a court",
  "search.intro": "Search every venue at once — pick a sport and a time, and see what's free.",
  "search.today": "Today",
  "search.from": "From",
  "search.until": "Until",
  "search.for": "For",
  "search.hours_one": "{n} hour",
  "search.hours_other": "{n} hours",
  "search.area": "Area",
  "search.anywhere": "Anywhere",
  "search.working": "Searching…",
  "search.failed": "Search failed",
  "search.count_one": "{n} venue slot for",
  "search.count_other": "{n} venue slots for",
  "search.on": "on",
  "search.to": "to {time}",
  "search.moreCourts_one": " +{n} more court free",
  "search.moreCourts_other": " +{n} more courts free",
  "search.fromPrice": "from",
  "search.book": "Book",
  "search.none":
    "No {sport} courts free in that window. Try a wider time range, another day, or a different area.",

  // Classes
  "classes.title": "Classes",
  "classes.intro": "Instructor-led sessions you join rather than book a court for.",
  "classes.all": "All",
  "classes.loading": "Loading…",
  "classes.loadFailed": "Failed to load classes",
  "classes.none": "No upcoming classes.",
  "classes.noneFor": "No upcoming classes for {sport}.",
  "classes.to": "to {time}",
  "classes.with": "with {instructor} · {venue} ({area})",
  "classes.full": "Full",
  "classes.left": "{left} of {capacity} left",
  "classes.joinWaitlist": "Join waitlist",
  "classes.enrol": "Enrol",
  "classes.queuedTitle": "You're on the waitlist",
  "classes.queuedBody": "Number {position} in the queue for {name}.",
  "classes.queuedNote":
    "If someone cancels, the place is offered to whoever has waited longest. Signed-in customers see the offer on their account page.",
  "classes.enrolledTitle": "You're enrolled",
  "classes.enrolledWith": "{name} with {instructor}",
  "classes.enrolledNote": "Show this at the desk, or check in with the QR code on your booking.",
  "classes.summary": "{from} – {to} with {instructor} · RM{price}",
  "classes.fullNote":
    "This class is full. Join the waitlist and we'll offer you the first place that frees up.",
  "classes.joining": "Joining…",
  "classes.enrolling": "Enrolling…",
  "classes.enrolPrice": "Enrol · RM{price}",
  "classes.joinFailed": "Could not join",
  "classes.enrolFailed": "Enrolment failed",

  // Looking up a booking
  "mine.title": "My Booking",
  "mine.intro": "Enter your booking code and the phone number you booked with.",
  "mine.code": "Booking code",
  "mine.phone": "Phone number",
  "mine.find": "Find my booking",
  "mine.lookupFailed": "Lookup failed",
  "mine.confirmed": "Confirmed",
  "mine.cancelled": "Cancelled",
  "mine.venue": "Venue",
  "mine.address": "Address",
  "mine.court": "Court",
  "mine.date": "Date",
  "mine.time": "Time",
  "mine.bookedBy": "Booked by",
  "mine.total": "Total",
  "mine.paid": "RM{amount} ✓ paid",
  "mine.unpaid": "RM{amount} (pay at counter)",
  "mine.freeCancel_one": "Free cancellation until {n} hour before your slot starts.",
  "mine.freeCancel_other": "Free cancellation until {n} hours before your slot starts.",
  "mine.checkedIn": "✓ Checked in",
  "mine.cancelBooking": "Cancel booking",
  "mine.cancelConfirm": "Cancel this booking? The slots will be released.",
  "mine.cancelFailed": "Cancellation failed",

  // Letting yourself in
  "door.nobodyOn": "Nobody is on the door at {court}",
  "door.hint": "Let yourself in with the code below. It appears an hour before your slot.",
  "door.yoursUntil": "Yours until {time}. Please do not pass it on.",
  "door.emergencyTitle": "If something goes wrong",
  "door.emergencyServices": "Emergency services:",
  "door.venuePhone": "Venue:",
  "door.alone": "You are the only person checked in right now. Tell someone where you are.",
  "door.withOthers": "{n} people are checked in right now, including you.",
  "door.show": "Show me the door code",
  "door.failed": "Could not get the code",

  // Privacy notice. PDPA s.7(2) wants this in both languages.
  "privacy.metaTitle": "Privacy notice · {site}",
  "privacy.metaDescription":
    "What {site} holds about you, why, for how long, and how to get it back or removed.",
  "privacy.title": "Privacy notice",
  "privacy.intro":
    "{site} books courts, gym places and classes for the venues listed on this site. This says what we hold about you, why, how long for, and what you can do about it. It is written to be read rather than to be survived.",
  "privacy.heldTitle": "What we hold, and why",
  "privacy.colWhat": "What",
  "privacy.colWhy": "Why",
  "privacy.colHowLong": "How long",
  "privacy.held1What": "Your name and phone number",
  "privacy.held1Why": "To hold the court in your name and to reach you if something changes",
  "privacy.held1How": "On the booking",
  "privacy.held2What": "Your email, if you give one",
  "privacy.held2Why": "To send you the booking confirmation you asked for",
  "privacy.held2How": "On the booking",
  "privacy.held3What": "What you paid and how",
  "privacy.held3Why": "The venue's accounting record, which it has to keep",
  "privacy.held3How": "Kept, without your name, after the period below",
  "privacy.held4What": "When you arrived and left",
  "privacy.held4Why": "So the venue knows who is inside, and the live crowd figure is honest",
  "privacy.held4How": "{n} days",
  "privacy.held5What": "Door codes shown to you",
  "privacy.held5Why": "So a venue running unstaffed hours knows who was let in",
  "privacy.held5How": "{n} days",
  "privacy.held6What": "Your induction, if you use unstaffed hours",
  "privacy.held6Why": "Proof that somebody showed you the emergency button in person",
  "privacy.held6How": "While it stands",
  "privacy.held7What": "Stored credit, passes and memberships",
  "privacy.held7Why": "Money and entries the venue owes you",
  "privacy.held7How": "Until spent or expired",
  "privacy.anonAfter": "Bookings stop naming anybody after",
  "privacy.years": "{n} years",
  "privacy.anonRest":
    ". The hour and the price stay, because that is the venue's record of its own takings; your name, number and email come off it.",
  "privacy.seeTitle": "Who can see it",
  "privacy.seeVenueLead": "The venue you booked.",
  "privacy.seeVenueBody":
    "Its staff see your booking, your payment status and whether you arrived. They cannot see another venue's customers — that is enforced by the software, not by asking nicely.",
  "privacy.seeNoneLead": "Nobody else.",
  "privacy.seeNoneBody":
    "We do not sell anything to anybody, and there is no advertising or analytics service in this site.",
  "privacy.doTitle": "What you can do",
  "privacy.doSeeLead": "See it.",
  "privacy.doSeeBody1": "Sign in and use",
  "privacy.doSeeLink": "Download a copy",
  "privacy.doSeeBody2":
    "on your account page to get everything held against your account, in one file. Anything bought at a counter — a pass, a membership, an induction — is filed against a phone number rather than a login, so ask the venue for those: they check who you are in person, which a website cannot.",
  "privacy.doFixLead": "Correct it.",
  "privacy.doFixBody": "Ask the venue — they can change a name or a number on a booking.",
  "privacy.doEraseLead": "Have it removed.",
  "privacy.doEraseLink": "Close my account",
  "privacy.doEraseBody":
    "on the same page. Upcoming bookings made from the account are cancelled and your name comes off the past ones. A booking you made as a guest, without signing in, is not linked to the account — ask the venue to remove those. If a venue still owes you credit, a pass or a membership, settle that first: we will not erase the record of whose money it is.",
  "privacy.doGuestLead": "Book without an account at all.",
  "privacy.doGuestBody": "A name and a phone number is enough, and then there is no account to close.",
  "privacy.draftTitle": "Before this site goes live",
  "privacy.draftBody":
    "This notice describes what the software actually does, which is the hard part — but it is not legal advice and it is not finished. It is here in Bahasa Malaysia and English, as Malaysia's PDPA expects, but the translation has not been checked by a lawyer and there is still no named person to write to. Add both, and have a lawyer read it, before taking a real customer's booking.",

  // Account
  "acct.greeting": "Hi, {name} 👋",
  "acct.signOut": "Sign out",
  "acct.loadFailed": "Failed to load bookings",
  "acct.upcoming": "Upcoming bookings",
  "acct.noneUpcoming": "No upcoming bookings.",
  "acct.bookOne": "Book a court",
  "acct.pastTitle": "Past & cancelled",
  "acct.colCode": "Code",
  "acct.colCourt": "Court",
  "acct.colDate": "Date",
  "acct.colTime": "Time",
  "acct.colTotal": "Total",
  "acct.colStatus": "Status",
  "acct.played": "played",
  "acct.cancelledLower": "cancelled",
  "acct.seriesTitle": "Part of a weekly series",
  "acct.paid": "✓ paid",
  "acct.payAtCounter": "(pay at counter)",
  "acct.share": "Share",
  "acct.calendar": "Calendar",
  "acct.cancelSeriesConfirm": "Cancel ALL upcoming sessions in series {code}?",
  "acct.cancelWholeSeries": "Cancel whole series",

  // Your data
  "data.title": "Your data",
  "data.intro1":
    "Everything {site} holds about you is yours to take a copy of, and yours to have removed. What we keep and for how long is set out in the",
  "data.privacyLink": "privacy notice",
  "data.download": "Download a copy",
  "data.close": "Close my account",
  "data.closing": "Closing…",
  "data.keep": "Keep it",
  "data.irreversible": "This cannot be undone.",
  "data.point1": "Any booking you have coming up is cancelled and the court released.",
  "data.point2": "Your name and number come off every booking made from this account.",
  "data.point3":
    "Bookings you made as a guest, without signing in, are not linked to this account — ask the venue to remove those.",
  "data.point4":
    "Venues keep what each booking cost them to run — that is their accounting record, and it will no longer say who you are.",
  "data.owedFirst":
    "If you hold credit, a pass or a membership, spend it or ask the venue to refund it first — we will not let you close the account while a venue still owes you something.",
  "data.typeDelete": "Type DELETE",
  "data.closeFailed": "Could not close the account",

  // Credit, passes, waitlist
  "wallet.title": "Credit balance",
  "wallet.intro": "Top up at any venue counter, then pay for bookings without cash.",
  "wallet.showHistory": "Show history",
  "wallet.hideHistory": "Hide history",
  "passes.title": "My passes",
  "passes.intro":
    "One entry covers one booked hour. Pick a pass on the booking form, or quote its code at the counter.",
  "passes.anySport": "any sport",
  "passes.ofLeft": " of {n} left",
  "passes.used": "{n} used",
  "passes.validUntil": "Valid until {date}",
  "wait.title": "Waitlist",
  "wait.aClass": "Class",
  "wait.held": "A place is being held for you — {minutes} min left",
  "wait.waiting": "Waiting for a place",
  "wait.claim": "Claim place",
  "wait.leave": "Leave",
  "wait.leaveConfirm": "Leave this waitlist?",

  // Check-in QR
  "qr.show": "Show check-in code",
  "qr.hide": "Hide check-in code",
  "qr.alt": "Scan this code at the venue to check in",
  "qr.note": "Scan at the venue to check yourself in. Opens an hour before your slot.",

  // Messages sent to the customer. These are plain text: they go out over
  // WhatsApp or email, not into a page, so no markup and no abbreviations.
  "msg.confirmedSubject": "Booking {code} confirmed — {venue}",
  "msg.confirmed":
    "Hi {name}, your booking is confirmed.\n\nCode: {code}\n{where}\n{when}\nTotal: {total}\n\nShow the code at the front desk. To see, pay or cancel it, open {link} and enter the code.",
  "msg.seriesSubject": "{weeks} weekly sessions booked — {venue}",
  "msg.series":
    "Hi {name}, your weekly sessions are booked.\n\nSeries code: {code}\n{where}\n{weeks} weeks from {when}\nTotal: {total}\n\nShow the code at the front desk. To see, pay or cancel, open {link} and enter the series code.",
  "msg.where": "{court} at {venue}",
  "msg.when": "{date}, {from} to {to}",
  "msg.total": "RM{amount}, {payment}",
  "msg.payAtCounter": "pay at the counter",
  "msg.payAtCounterOrOnline": "pay at the counter or online",
  "msg.paid": "already paid",

  // Paying online
  "pay.button": "Pay RM{amount} online",
  "pay.opening": "Opening the payment page…",
  "pay.failed": "The payment page could not be opened.",
  "pay.how": "FPX online banking or card, through Billplz. Or pay at the counter as usual.",
  "pay.paidOnline": "Paid online",
  "pay.receivedTitle": "Payment received",
  "pay.receivedBody": "Thank you. RM{amount} has been paid for {codes}. Show your booking code at the front desk as usual.",
  "pay.notPaidTitle": "Payment not completed",
  "pay.notPaidBody": "Nothing was taken. Your booking still stands: pay at the counter, or try again from My Booking.",
  "pay.unknownTitle": "We could not confirm that payment",
  "pay.unknownBody": "If money left your account, the venue will see it shortly. Look your booking up under My Booking to check.",
  "pay.toMyBooking": "Go to My Booking",
  "msg.cancelledSubject": "Booking {code} cancelled — {venue}",
  "msg.cancelled":
    "Hi {name}, booking {code} has been cancelled.\n\n{where}\n{when}\n\nThe slot is free again. Nothing is owed for it.",
  "msg.offerSubject": "A place has opened up — {venue}",
  "msg.offer":
    "Hi {name}, a place has opened up for {what} at {venue}, {date} {from}.\n\nIt is held for you for a short while, and then goes to the next person waiting. Claim it at {link} while it is yours.",
  "msg.enrolledSubject": "Enrolled in {what} — {venue}",
  "msg.enrolled":
    "Hi {name}, you are enrolled in {what} with {instructor}.\n\nCode: {code}\n{venue}\n{when}\nTotal: {total}\n\nShow the code at the front desk.",

  // Refusals a customer can be shown. The English here is the text the store
  // used to carry inline, so a code and its sentence cannot drift apart.
  "err.COURT_NOT_FOUND": "Court not found.",
  "err.VENUE_NOT_FOUND": "Venue not found.",
  "err.UNKNOWN_SPORT": "Unknown sport.",
  "err.NO_SPORT_AT_VENUE": "That venue has no {sport} courts.",
  "err.NO_COURT_FREE": "No court is free for that whole time. Please pick another time.",
  "err.WEEKS_RANGE": "Weeks must be between 1 and {max}.",
  "err.DATE_OUT_OF_WINDOW_FIRST": "The first date is outside the booking window.",
  "err.DATE_OUT_OF_WINDOW": "Date is outside the booking window.",
  "err.NO_HOURS": "Select at least one hour.",
  "err.MAX_HOURS": "Maximum {max} hours per booking.",
  "err.HOURS_NOT_CONSECUTIVE": "Selected hours must be consecutive.",
  "err.HOURS_OUTSIDE_OPENING": "Selected hours are outside operating hours.",
  "err.THOSE_HOURS_OUTSIDE_OPENING": "Those hours are outside operating hours.",
  "err.SLOT_PAST": "That time slot has already passed.",
  "err.TIME_PAST": "That time has already passed.",
  "err.VENUE_CLOSED": "The venue is closed that day.",
  "err.SERIES_ALL_TAKEN":
    "Every week in that series is already taken. Please pick another slot.",
  "err.FILLING_FAST": "That session is filling up very quickly. Please try again.",
  "err.BOOKING_NOT_FOUND": "Booking not found.",
  "err.BOOKING_NOT_FOUND_CODE": "Booking not found. Check the code and phone number.",
  "err.ALREADY_CANCELLED": "This booking is already cancelled.",
  "err.BOOKING_WAS_CANCELLED": "This booking was cancelled.",
  "err.KIT_STILL_OUT":
    "The kit for this booking is still out. Bring it back to the desk first.",
  "err.SERIES_NOT_FOUND": "Series not found. Check the series code and phone number.",
  "err.SERIES_NONE_LEFT_one": "No sessions left to cancel — the rest start within {n} hour.",
  "err.SERIES_NONE_LEFT_other": "No sessions left to cancel — the rest start within {n} hours.",
  "err.CLASS_NOT_FOUND": "Class not found.",
  "err.CLASS_FULL": "This class is full.",
  "err.CLASS_STARTED": "This class has already started.",
  "err.CLASS_CANCELLED": "This class was cancelled.",
  "err.ALREADY_ENROLLED": "You are already enrolled in this class.",
  "err.CLASS_HAS_PLACES": "This class still has places — enrol instead.",
  "err.ALREADY_WAITING": "You are already on this waitlist.",
  "err.SLOT_FREE_BOOK_IT": "That slot is free — book it instead.",
  "err.OFFER_EXPIRED": "This offer has expired or was already claimed.",
  "err.OFFER_INVALID": "This offer is no longer valid.",
  "err.PLACE_ALREADY_CLAIMED": "This place was already claimed.",
  "err.WAITLIST_NOT_FOUND": "Waitlist entry not found.",
  "err.NOT_ENOUGH_CREDIT": "Not enough credit. Top up at the counter or pay there.",
  "err.NO_ACCOUNT_TO_CHARGE": "This booking has no account to charge.",
  "err.ALREADY_PAID": "This booking is already paid.",
  "err.PASS_NOT_FOUND": "Pass not found.",
  "err.PASS_WRONG_PHONE": "That pass belongs to a different phone number.",
  "err.PROMO_ALREADY_USED": "A code has already been used on this booking.",
  "err.PROMO_TOO_LATE": "This booking is already paid; a code cannot be added now.",
  "passes.counterNote":
    "Bought a pass or membership at the counter? Ask the venue to put your account email on it and it will appear here. They check who you are in person, which this page cannot.",
} as const;

export type Phrase = keyof typeof EN;

/** Bahasa Malaysia, keyed against the English above. */
const MS: Record<Phrase, string> = {
  // Shell
  "meta.title": "{site} — Tempah Gelanggang, Gim & Kelas Dalam Talian",
  "meta.description":
    "Tempah gelanggang badminton, tenis, pickleball dan futsal, sesi gim dan kelas di seluruh Lembah Klang dalam beberapa saat.",
  "nav.venues": "Gelanggang",
  "nav.find": "Cari gelanggang",
  "nav.classes": "Kelas",
  "nav.myBooking": "Tempahan Saya",
  "nav.admin": "Admin",
  "nav.signIn": "Log masuk",
  "footer.tagline":
    "{site} — gelanggang, gim dan kelas, satu tempahan. Untuk badminton, tenis, pickleball, futsal, gim & renang.",
  "footer.privacy": "Notis privasi",
  "lang.label": "Bahasa",

  // Home
  "home.heroTitle": "Tempah gelanggang dalam beberapa saat.",
  "home.heroBody":
    "Badminton, tenis, pickleball dan futsal — lihat kekosongan secara langsung, pilih waktu anda dan terus dapat kod tempahan. Tak perlu telefon, tak perlu tunggu. Mudah je!",
  "home.heroCta": "Cari gelanggang ikut waktu",
  "home.venuesTitle": "Gelanggang",
  "home.venuesIntro": "Pilih sebuah pusat untuk melihat kekosongan gelanggang secara langsung, atau",
  "home.venuesSearchLink": "cari semua pusat serentak",
  "home.courts_one": "{n} gelanggang",
  "home.courts_other": "{n} gelanggang",
  "home.fromRate": "dari RM{rate}/jam",
  "home.step1Title": "1. Pilih waktu",
  "home.step1Body": "Pilih pusat, tarikh dan gelanggang — kekosongan dipaparkan secara langsung.",
  "home.step2Title": "2. Sahkan",
  "home.step2Body": "Masukkan nama dan nombor telefon anda. Bayar di kaunter apabila tiba.",
  "home.step3Title": "3. Main",
  "home.step3Body": "Anda terus dapat kod tempahan. Tunjukkan di kaunter hadapan.",

  // Sukan
  "sport.badminton": "Badminton",
  "sport.tennis": "Tenis",
  "sport.pickleball": "Pickleball",
  "sport.futsal": "Futsal",
  "sport.gym": "Gim",
  "sport.swimming": "Renang",
  "sport.kayak": "Sewa kayak",

  // Venue
  "venue.openDaily": "Buka setiap hari {from} – {to}",
  "venue.freeCancel_one": "pembatalan percuma sehingga {n} jam sebelum waktu anda",
  "venue.freeCancel_other": "pembatalan percuma sehingga {n} jam sebelum waktu anda",
  "venue.cancelAnyTime": "batal bila-bila masa sebelum waktu anda bermula",
  "venue.closures": "Hari tutup akan datang:",

  // Log masuk / daftar
  "auth.welcomeBack": "Selamat kembali",
  "auth.createAccount": "Buka akaun",
  "auth.signInIntro": "Log masuk untuk melihat dan menguruskan tempahan anda.",
  "auth.registerIntro": "Daftar untuk simpan semua tempahan anda di satu tempat.",
  "auth.signIn": "Log masuk",
  "auth.register": "Daftar",
  "auth.name": "Nama",
  "auth.namePlaceholder": "Ali bin Abu",
  "auth.phone": "Telefon",
  "auth.phonePlaceholder": "012-345 6789",
  "auth.email": "E-mel",
  "auth.emailPlaceholder": "anda@contoh.com",
  "auth.password": "Kata laluan",
  "auth.passwordHint": "Sekurang-kurangnya 8 aksara",
  "auth.creating": "Buka akaun",
  "auth.working": "Sila tunggu…",
  "auth.failed": "Ada masalah berlaku",

  // Daftar masuk
  "checkin.working": "Sedang mendaftar masuk anda…",
  "checkin.doneTitle": "Anda sudah daftar masuk",
  "checkin.doneBody": "Selamat bermain, {name}.",
  "checkin.venue": "Pusat",
  "checkin.facility": "Kemudahan",
  "checkin.time": "Waktu",
  "checkin.code": "Kod",
  "checkin.failedTitle": "Tidak dapat daftar masuk",
  "checkin.failed": "Daftar masuk gagal",
  "checkin.tryAgain": "Cuba lagi",
  "checkin.stuck": "Masih tersekat? Kaunter hadapan boleh daftarkan anda secara manual.",
  "checkin.back": "Kembali ke {site}",

  // Menuntut tempat senarai menunggu
  "claim.yoursTitle": "Tempat ini milik anda",
  "claim.with": "{name} bersama {instructor}",
  "claim.payable": "RM{amount}, dibayar di kaunter.",
  "claim.goneTitle": "Tawaran tidak lagi tersedia",
  "claim.goneBody":
    "Tempat ditawarkan mengikut giliran dan ditahan untuk seketika. Jika giliran anda sudah tamat, anda boleh masuk senarai menunggu semula.",
  "claim.openTitle": "Ada tempat kosong",
  "claim.openBody":
    "Seseorang telah membatalkan dan anda yang seterusnya dalam giliran. Tuntut sebelum tempohnya tamat.",
  "claim.button": "Tuntut tempat saya",
  "claim.working": "Sedang menuntut…",
  "claim.failed": "Tidak dapat menuntut tempat itu",
  "claim.back": "Kembali ke kelas",

  // Tahap kesibukan
  "live.title": "Di sini sekarang",
  "live.updated": "langsung · dikemas kini {time}",
  "live.inside": "{present}/{capacity} masuk",
  "live.source": "Dikira daripada daftar masuk di kaunter hadapan.",
  "busy.quiet": "Lengang",
  "busy.filling": "Mula penuh",
  "busy.busy": "Sibuk",
  "busy.full": "Penuh",

  // Papan tempahan
  "board.loadFailed": "Gagal memuatkan kekosongan",
  "board.closed": "Tutup pada {date}.",
  "board.pickAnother": "Sila pilih tarikh lain.",
  "board.memberTitle": "Harga ahli.",
  "board.memberBody": "Anda ahli di sini, jadi kadar di bawah adalah kadar anda.",
  "board.loading": "Memuatkan kekosongan…",
  "board.court": "Gelanggang",
  "board.anyCourt": "Mana-mana gelanggang",
  "board.anyCourtHint": "yang kosong dan paling murah",
  "board.places": "{n} tempat",
  "board.depositLine": "deposit RM{amount}",
  "board.anyFree_one": "{time} · dari RM{rate} · {n} gelanggang kosong",
  "board.anyFree_other": "{time} · dari RM{rate} · {n} gelanggang kosong",
  "board.anyNone": "Tiada gelanggang kosong pada waktu ini",
  "board.queueHint": "Sudah ditempah — klik untuk masuk senarai menunggu",
  "board.reservedFor": "Dikhaskan untuk {name}",
  "board.unavailable": "Tidak tersedia",
  "board.sharedSlot": "{time} · RM{rate} · tinggal {left} daripada {capacity} tempat ({level})",
  "board.plainSlot": "{time} · RM{rate}",
  "board.legendFree": "Kosong (nombor = RM/jam)",
  "board.legendShared": "Kemudahan berkongsi (nombor = tempat berbaki)",
  "board.legendSelected": "Dipilih",
  "board.legendTaken": "Ditempah / sudah lepas",
  "board.maxHours": "Maksimum {n} jam berturut-turut setiap tempahan",
  "board.noCourts": "Tiada gelanggang {sport} di pusat ini.",

  // Bar tempahan
  "form.depositNote":
    "Tambah deposit RM{amount} di kaunter, dipulangkan apabila peralatan dipulangkan.",
  "form.name": "Nama",
  "form.phone": "Telefon",
  "form.emailOptional": "E-mel (pilihan)",
  "form.repeat": "Ulang",
  "form.justOnce": "Sekali sahaja",
  "form.weekly": "Mingguan × {n}",
  "form.booking": "Menempah…",
  "form.bookWeeks": "Tempah {weeks} minggu · RM{amount}/mgg",
  "form.book": "Tempah · RM{amount}",
  "form.payFromCredit": "Bayar guna baki kredit saya (RM{amount} ada)",
  "form.promoLabel": "Ada kod promosi?",
  "form.promoChecked": "Disemak semasa anda menempah; jumlah akan dikemas kini.",
  "form.passLabel": "Guna pas?",
  "form.passNone": "Tidak — bayar di kaunter",
  "form.passOption": "{name} · tinggal {n}",
  "form.passSpend_one": "Menggunakan {n} kemasukan{per}.",
  "form.passSpend_other": "Menggunakan {n} kemasukan{per}.",
  "form.passPerWeek": " setiap minggu ({total} kesemuanya)",
  "form.skipTaken":
    "Langkau minggu yang sudah ditempah (jika tidak, seluruh siri ditolak apabila ada pertindihan)",
  "form.failed": "Tempahan gagal",

  // Pengesahan
  "done.seriesTitle": "{n} sesi mingguan telah ditempah!",
  "done.title": "Tempahan disahkan!",
  "done.body":
    "Tunjukkan kod ini di kaunter. Simpan ia — anda perlukannya (bersama nombor telefon anda) untuk melihat atau membatalkan {what}.",
  "done.theSeries": "siri ini",
  "done.theBooking": "tempahan ini",
  "done.venue": "Pusat",
  "done.court": "Gelanggang",
  "done.date": "Tarikh",
  "done.time": "Waktu",
  "done.promoDiscount": "Diskaun promosi",
  "done.total": "Jumlah",
  "done.totalValue": "RM{amount} (bayar di kaunter)",
  "done.deposit": "Deposit",
  "done.depositValue": "RM{amount}, dipulangkan bersama peralatan",
  "done.promoRejected": "Kod promosi anda tidak digunakan: {reason}",
  "done.sessions": "Sesi",
  "done.skipped": "dilangkau — {reason}",
  "done.icsFile": "fail .ics",
  "done.close": "Selesai",

  // Masuk senarai menunggu untuk satu waktu
  "queue.onTitle": "Anda dalam senarai menunggu",
  "queue.onBody": "Nombor {position} untuk {court} pada {time}.",
  "queue.onNote":
    "Jika ia kosong, waktu itu ditawarkan kepada sesiapa yang paling lama menunggu. Pelanggan yang log masuk akan nampak tawaran itu di halaman akaun mereka.",
  "queue.taken":
    "Waktu ini sudah ditempah. Masuk senarai menunggu dan kami akan tawarkan kepada anda jika ia kosong.",
  "queue.cancel": "Batal",
  "queue.join": "Masuk senarai menunggu",
  "queue.joining": "Sedang masuk…",
  "queue.failed": "Tidak dapat masuk senarai menunggu",

  // Carian
  "search.title": "Cari gelanggang",
  "search.intro":
    "Cari semua pusat serentak — pilih sukan dan waktu, dan lihat apa yang kosong.",
  "search.today": "Hari ini",
  "search.from": "Dari",
  "search.until": "Hingga",
  "search.for": "Selama",
  "search.hours_one": "{n} jam",
  "search.hours_other": "{n} jam",
  "search.area": "Kawasan",
  "search.anywhere": "Mana-mana",
  "search.working": "Sedang mencari…",
  "search.failed": "Carian gagal",
  "search.count_one": "{n} waktu di pusat untuk",
  "search.count_other": "{n} waktu di pusat untuk",
  "search.on": "pada",
  "search.to": "hingga {time}",
  "search.moreCourts_one": " +{n} gelanggang lagi kosong",
  "search.moreCourts_other": " +{n} gelanggang lagi kosong",
  "search.fromPrice": "dari",
  "search.book": "Tempah",
  "search.none":
    "Tiada gelanggang {sport} kosong dalam waktu itu. Cuba julat waktu yang lebih luas, hari lain, atau kawasan lain.",

  // Kelas
  "classes.title": "Kelas",
  "classes.intro": "Sesi beriringan jurulatih yang anda sertai, bukan tempahan gelanggang.",
  "classes.all": "Semua",
  "classes.loading": "Memuatkan…",
  "classes.loadFailed": "Gagal memuatkan kelas",
  "classes.none": "Tiada kelas akan datang.",
  "classes.noneFor": "Tiada kelas {sport} akan datang.",
  "classes.to": "hingga {time}",
  "classes.with": "bersama {instructor} · {venue} ({area})",
  "classes.full": "Penuh",
  "classes.left": "tinggal {left} daripada {capacity}",
  "classes.joinWaitlist": "Masuk senarai menunggu",
  "classes.enrol": "Daftar",
  "classes.queuedTitle": "Anda dalam senarai menunggu",
  "classes.queuedBody": "Nombor {position} dalam giliran untuk {name}.",
  "classes.queuedNote":
    "Jika ada yang membatalkan, tempat itu ditawarkan kepada sesiapa yang paling lama menunggu. Pelanggan yang log masuk akan nampak tawaran itu di halaman akaun mereka.",
  "classes.enrolledTitle": "Anda telah berdaftar",
  "classes.enrolledWith": "{name} bersama {instructor}",
  "classes.enrolledNote":
    "Tunjukkan ini di kaunter, atau daftar masuk dengan kod QR pada tempahan anda.",
  "classes.summary": "{from} – {to} bersama {instructor} · RM{price}",
  "classes.fullNote":
    "Kelas ini penuh. Masuk senarai menunggu dan kami akan tawarkan tempat pertama yang kosong.",
  "classes.joining": "Sedang masuk…",
  "classes.enrolling": "Sedang mendaftar…",
  "classes.enrolPrice": "Daftar · RM{price}",
  "classes.joinFailed": "Tidak dapat menyertai",
  "classes.enrolFailed": "Pendaftaran gagal",

  // Menyemak tempahan
  "mine.title": "Tempahan Saya",
  "mine.intro": "Masukkan kod tempahan dan nombor telefon yang anda guna semasa menempah.",
  "mine.code": "Kod tempahan",
  "mine.phone": "Nombor telefon",
  "mine.find": "Cari tempahan saya",
  "mine.lookupFailed": "Carian gagal",
  "mine.confirmed": "Disahkan",
  "mine.cancelled": "Dibatalkan",
  "mine.venue": "Pusat",
  "mine.address": "Alamat",
  "mine.court": "Gelanggang",
  "mine.date": "Tarikh",
  "mine.time": "Waktu",
  "mine.bookedBy": "Ditempah oleh",
  "mine.total": "Jumlah",
  "mine.paid": "RM{amount} ✓ sudah bayar",
  "mine.unpaid": "RM{amount} (bayar di kaunter)",
  "mine.freeCancel_one": "Pembatalan percuma sehingga {n} jam sebelum waktu anda bermula.",
  "mine.freeCancel_other": "Pembatalan percuma sehingga {n} jam sebelum waktu anda bermula.",
  "mine.checkedIn": "✓ Sudah daftar masuk",
  "mine.cancelBooking": "Batalkan tempahan",
  "mine.cancelConfirm": "Batalkan tempahan ini? Waktu itu akan dilepaskan.",
  "mine.cancelFailed": "Pembatalan gagal",

  // Masuk sendiri
  "door.nobodyOn": "Tiada sesiapa di pintu {court}",
  "door.hint": "Masuk sendiri dengan kod di bawah. Ia muncul sejam sebelum waktu anda.",
  "door.yoursUntil": "Milik anda sehingga {time}. Sila jangan berikan kepada orang lain.",
  "door.emergencyTitle": "Jika berlaku sesuatu",
  "door.emergencyServices": "Perkhidmatan kecemasan:",
  "door.venuePhone": "Pusat:",
  "door.alone":
    "Anda seorang sahaja yang berdaftar masuk sekarang. Beritahu seseorang di mana anda berada.",
  "door.withOthers": "{n} orang berdaftar masuk sekarang, termasuk anda.",
  "door.show": "Tunjukkan kod pintu",
  "door.failed": "Tidak dapat memperoleh kod",

  // Notis privasi. PDPA s.7(2) menghendaki ia dalam dua bahasa.
  "privacy.metaTitle": "Notis privasi · {site}",
  "privacy.metaDescription":
    "Apa yang {site} simpan tentang anda, kenapa, berapa lama, dan bagaimana untuk mendapatkannya semula atau membuangnya.",
  "privacy.title": "Notis privasi",
  "privacy.intro":
    "{site} menempah gelanggang, tempat gim dan kelas bagi pusat-pusat yang tersenarai di laman ini. Ini menerangkan apa yang kami simpan tentang anda, kenapa, berapa lama, dan apa yang boleh anda buat mengenainya. Ia ditulis untuk dibaca, bukan untuk ditahan.",
  "privacy.heldTitle": "Apa yang kami simpan, dan kenapa",
  "privacy.colWhat": "Apa",
  "privacy.colWhy": "Kenapa",
  "privacy.colHowLong": "Berapa lama",
  "privacy.held1What": "Nama dan nombor telefon anda",
  "privacy.held1Why":
    "Untuk menempah gelanggang atas nama anda dan menghubungi anda jika ada perubahan",
  "privacy.held1How": "Pada tempahan",
  "privacy.held2What": "E-mel anda, jika anda berikan",
  "privacy.held2Why": "Untuk menghantar pengesahan tempahan yang anda minta",
  "privacy.held2How": "Pada tempahan",
  "privacy.held3What": "Apa yang anda bayar dan bagaimana",
  "privacy.held3Why": "Rekod perakaunan pusat, yang wajib disimpan",
  "privacy.held3How": "Disimpan, tanpa nama anda, selepas tempoh di bawah",
  "privacy.held4What": "Waktu anda tiba dan keluar",
  "privacy.held4Why":
    "Supaya pusat tahu siapa berada di dalam, dan angka kesibukan langsung itu jujur",
  "privacy.held4How": "{n} hari",
  "privacy.held5What": "Kod pintu yang ditunjukkan kepada anda",
  "privacy.held5Why":
    "Supaya pusat yang beroperasi tanpa kakitangan tahu siapa yang dibenarkan masuk",
  "privacy.held5How": "{n} hari",
  "privacy.held6What": "Taklimat anda, jika anda guna waktu tanpa kakitangan",
  "privacy.held6Why":
    "Bukti bahawa seseorang telah menunjukkan butang kecemasan kepada anda secara bersemuka",
  "privacy.held6How": "Selagi ia sah",
  "privacy.held7What": "Kredit tersimpan, pas dan keahlian",
  "privacy.held7Why": "Wang dan kemasukan yang pusat hutang kepada anda",
  "privacy.held7How": "Sehingga habis digunakan atau luput",
  "privacy.anonAfter": "Tempahan berhenti menamakan sesiapa selepas",
  "privacy.years": "{n} tahun",
  "privacy.anonRest":
    ". Waktu dan harga kekal, kerana itu rekod kutipan pusat itu sendiri; nama, nombor dan e-mel anda dibuang daripadanya.",
  "privacy.seeTitle": "Siapa boleh melihatnya",
  "privacy.seeVenueLead": "Pusat yang anda tempah.",
  "privacy.seeVenueBody":
    "Kakitangannya nampak tempahan anda, status pembayaran anda dan sama ada anda hadir. Mereka tidak boleh melihat pelanggan pusat lain — itu dikuatkuasakan oleh perisian, bukan sekadar dengan meminta baik-baik.",
  "privacy.seeNoneLead": "Tiada sesiapa lagi.",
  "privacy.seeNoneBody":
    "Kami tidak menjual apa-apa kepada sesiapa, dan tiada perkhidmatan pengiklanan atau analitik di laman ini.",
  "privacy.doTitle": "Apa yang anda boleh buat",
  "privacy.doSeeLead": "Lihat ia.",
  "privacy.doSeeBody1": "Log masuk dan guna",
  "privacy.doSeeLink": "Muat turun satu salinan",
  "privacy.doSeeBody2":
    "di halaman akaun anda untuk mendapatkan semua yang disimpan pada akaun anda, dalam satu fail. Apa-apa yang dibeli di kaunter — pas, keahlian, taklimat — difailkan pada nombor telefon dan bukan pada akaun, jadi tanyalah pusat berkenaan: mereka mengesahkan siapa anda secara bersemuka, sesuatu yang laman web tidak mampu buat.",
  "privacy.doFixLead": "Betulkan ia.",
  "privacy.doFixBody":
    "Tanya pusat berkenaan — mereka boleh menukar nama atau nombor pada tempahan.",
  "privacy.doEraseLead": "Buang ia.",
  "privacy.doEraseLink": "Tutup akaun saya",
  "privacy.doEraseBody":
    "di halaman yang sama. Tempahan akan datang yang dibuat daripada akaun itu akan dibatalkan dan nama anda dibuang daripada yang lepas. Tempahan yang anda buat sebagai tetamu, tanpa log masuk, tidak terikat kepada akaun — minta pusat berkenaan membuangnya. Jika pusat masih berhutang kredit, pas atau keahlian kepada anda, selesaikan itu dahulu: kami tidak akan memadam rekod tentang wang siapa itu.",
  "privacy.doGuestLead": "Tempah tanpa akaun langsung.",
  "privacy.doGuestBody":
    "Nama dan nombor telefon sudah memadai, dan kemudian tiada akaun untuk ditutup.",
  "privacy.draftTitle": "Sebelum laman ini beroperasi",
  "privacy.draftBody":
    "Notis ini menerangkan apa yang perisian ini benar-benar lakukan, iaitu bahagian yang sukar — tetapi ia bukan nasihat guaman dan ia belum selesai. Ia ada dalam Bahasa Malaysia dan Bahasa Inggeris, seperti yang dikehendaki PDPA Malaysia, tetapi terjemahannya belum disemak oleh peguam dan masih tiada nama orang yang boleh dihubungi. Tambah kedua-duanya, dan minta peguam membacanya, sebelum menerima tempahan pelanggan sebenar.",

  // Akaun
  "acct.greeting": "Hai, {name} 👋",
  "acct.signOut": "Log keluar",
  "acct.loadFailed": "Gagal memuatkan tempahan",
  "acct.upcoming": "Tempahan akan datang",
  "acct.noneUpcoming": "Tiada tempahan akan datang.",
  "acct.bookOne": "Tempah gelanggang",
  "acct.pastTitle": "Lepas & dibatalkan",
  "acct.colCode": "Kod",
  "acct.colCourt": "Gelanggang",
  "acct.colDate": "Tarikh",
  "acct.colTime": "Waktu",
  "acct.colTotal": "Jumlah",
  "acct.colStatus": "Status",
  "acct.played": "sudah main",
  "acct.cancelledLower": "dibatalkan",
  "acct.seriesTitle": "Sebahagian daripada siri mingguan",
  "acct.paid": "✓ sudah bayar",
  "acct.payAtCounter": "(bayar di kaunter)",
  "acct.share": "Kongsi",
  "acct.calendar": "Kalendar",
  "acct.cancelSeriesConfirm": "Batalkan SEMUA sesi akan datang dalam siri {code}?",
  "acct.cancelWholeSeries": "Batalkan seluruh siri",

  // Data anda
  "data.title": "Data anda",
  "data.intro1":
    "Segala yang {site} simpan tentang anda boleh anda salin, dan boleh anda buang. Apa yang kami simpan dan berapa lama dinyatakan dalam",
  "data.privacyLink": "notis privasi",
  "data.download": "Muat turun satu salinan",
  "data.close": "Tutup akaun saya",
  "data.closing": "Sedang menutup…",
  "data.keep": "Kekalkan",
  "data.irreversible": "Ini tidak boleh dibatalkan.",
  "data.point1":
    "Mana-mana tempahan akan datang anda akan dibatalkan dan gelanggang itu dilepaskan.",
  "data.point2":
    "Nama dan nombor anda akan dibuang daripada setiap tempahan yang dibuat daripada akaun ini.",
  "data.point3":
    "Tempahan yang anda buat sebagai tetamu, tanpa log masuk, tidak terikat kepada akaun ini — minta pusat berkenaan membuangnya.",
  "data.point4":
    "Pusat menyimpan kos setiap tempahan — itu rekod perakaunan mereka, dan ia tidak lagi menyatakan siapa anda.",
  "data.owedFirst":
    "Jika anda ada kredit, pas atau keahlian, gunakannya atau minta pusat memulangkan wang dahulu — kami tidak akan benarkan anda menutup akaun sementara pusat masih berhutang kepada anda.",
  "data.typeDelete": "Taip DELETE",
  "data.closeFailed": "Tidak dapat menutup akaun",

  // Kredit, pas, senarai menunggu
  "wallet.title": "Baki kredit",
  "wallet.intro":
    "Tambah nilai di mana-mana kaunter pusat, kemudian bayar tempahan tanpa tunai.",
  "wallet.showHistory": "Tunjuk sejarah",
  "wallet.hideHistory": "Sembunyi sejarah",
  "passes.title": "Pas saya",
  "passes.intro":
    "Satu kemasukan meliputi satu jam yang ditempah. Pilih pas pada borang tempahan, atau sebut kodnya di kaunter.",
  "passes.anySport": "apa-apa sukan",
  "passes.ofLeft": " daripada {n} berbaki",
  "passes.used": "{n} digunakan",
  "passes.validUntil": "Sah sehingga {date}",
  "wait.title": "Senarai menunggu",
  "wait.aClass": "Kelas",
  "wait.held": "Satu tempat sedang ditahan untuk anda — tinggal {minutes} minit",
  "wait.waiting": "Menunggu tempat",
  "wait.claim": "Tuntut tempat",
  "wait.leave": "Keluar",
  "wait.leaveConfirm": "Keluar daripada senarai menunggu ini?",

  // Kod QR daftar masuk
  "qr.show": "Tunjuk kod daftar masuk",
  "qr.hide": "Sembunyi kod daftar masuk",
  "qr.alt": "Imbas kod ini di pusat untuk daftar masuk",
  "qr.note":
    "Imbas di pusat untuk daftar masuk sendiri. Dibuka sejam sebelum waktu anda.",

  // Mesej kepada pelanggan. Teks biasa: ia dihantar melalui WhatsApp atau
  // e-mel, bukan ke dalam halaman, jadi tiada markup dan tiada singkatan.
  "msg.confirmedSubject": "Tempahan {code} disahkan — {venue}",
  "msg.confirmed":
    "Hai {name}, tempahan anda telah disahkan.\n\nKod: {code}\n{where}\n{when}\nJumlah: {total}\n\nTunjukkan kod ini di kaunter hadapan. Untuk melihat, membayar atau membatalkannya, buka {link} dan masukkan kod ini.",
  "msg.seriesSubject": "{weeks} sesi mingguan ditempah — {venue}",
  "msg.series":
    "Hai {name}, sesi mingguan anda telah ditempah.\n\nKod siri: {code}\n{where}\n{weeks} minggu bermula {when}\nJumlah: {total}\n\nTunjukkan kod ini di kaunter hadapan. Untuk melihat, membayar atau membatalkan, buka {link} dan masukkan kod siri.",
  "msg.where": "{court} di {venue}",
  "msg.when": "{date}, {from} hingga {to}",
  "msg.total": "RM{amount}, {payment}",
  "msg.payAtCounter": "bayar di kaunter",
  "msg.payAtCounterOrOnline": "bayar di kaunter atau dalam talian",
  "msg.paid": "sudah dibayar",

  // Paying online
  "pay.button": "Bayar RM{amount} dalam talian",
  "pay.opening": "Membuka halaman pembayaran…",
  "pay.failed": "Halaman pembayaran tidak dapat dibuka.",
  "pay.how": "Perbankan dalam talian FPX atau kad, melalui Billplz. Atau bayar di kaunter seperti biasa.",
  "pay.paidOnline": "Dibayar dalam talian",
  "pay.receivedTitle": "Pembayaran diterima",
  "pay.receivedBody": "Terima kasih. RM{amount} telah dibayar untuk {codes}. Tunjukkan kod tempahan anda di kaunter hadapan seperti biasa.",
  "pay.notPaidTitle": "Pembayaran tidak selesai",
  "pay.notPaidBody": "Tiada apa-apa yang ditolak. Tempahan anda masih sah: bayar di kaunter, atau cuba lagi dari Tempahan Saya.",
  "pay.unknownTitle": "Kami tidak dapat mengesahkan pembayaran itu",
  "pay.unknownBody": "Jika wang telah keluar dari akaun anda, pihak tempat akan melihatnya sebentar lagi. Cari tempahan anda di Tempahan Saya untuk menyemak.",
  "pay.toMyBooking": "Pergi ke Tempahan Saya",
  "msg.cancelledSubject": "Tempahan {code} dibatalkan — {venue}",
  "msg.cancelled":
    "Hai {name}, tempahan {code} telah dibatalkan.\n\n{where}\n{when}\n\nWaktu itu kosong semula. Tiada apa-apa yang perlu dibayar untuknya.",
  "msg.offerSubject": "Ada tempat kosong — {venue}",
  "msg.offer":
    "Hai {name}, ada tempat kosong untuk {what} di {venue}, {date} {from}.\n\nIa ditahan untuk anda seketika sahaja, kemudian diberikan kepada orang seterusnya dalam giliran. Tuntut di {link} selagi ia milik anda.",
  "msg.enrolledSubject": "Berdaftar dalam {what} — {venue}",
  "msg.enrolled":
    "Hai {name}, anda telah berdaftar dalam {what} bersama {instructor}.\n\nKod: {code}\n{venue}\n{when}\nJumlah: {total}\n\nTunjukkan kod ini di kaunter hadapan.",

  // Penolakan yang boleh dilihat pelanggan.
  "err.COURT_NOT_FOUND": "Gelanggang tidak dijumpai.",
  "err.VENUE_NOT_FOUND": "Pusat tidak dijumpai.",
  "err.UNKNOWN_SPORT": "Sukan tidak dikenali.",
  "err.NO_SPORT_AT_VENUE": "Pusat itu tiada gelanggang {sport}.",
  "err.NO_COURT_FREE":
    "Tiada gelanggang kosong untuk sepanjang waktu itu. Sila pilih waktu lain.",
  "err.WEEKS_RANGE": "Bilangan minggu mesti antara 1 dan {max}.",
  "err.DATE_OUT_OF_WINDOW_FIRST": "Tarikh pertama itu di luar tempoh tempahan yang dibenarkan.",
  "err.DATE_OUT_OF_WINDOW": "Tarikh itu di luar tempoh tempahan yang dibenarkan.",
  "err.NO_HOURS": "Pilih sekurang-kurangnya satu jam.",
  "err.MAX_HOURS": "Maksimum {max} jam bagi setiap tempahan.",
  "err.HOURS_NOT_CONSECUTIVE": "Jam yang dipilih mesti berturut-turut.",
  "err.HOURS_OUTSIDE_OPENING": "Jam yang dipilih di luar waktu operasi.",
  "err.THOSE_HOURS_OUTSIDE_OPENING": "Jam tersebut di luar waktu operasi.",
  "err.SLOT_PAST": "Waktu itu sudah berlalu.",
  "err.TIME_PAST": "Waktu tersebut sudah berlalu.",
  "err.VENUE_CLOSED": "Pusat itu tutup pada hari tersebut.",
  "err.SERIES_ALL_TAKEN":
    "Setiap minggu dalam siri itu sudah ditempah. Sila pilih waktu lain.",
  "err.FILLING_FAST": "Sesi itu sedang penuh dengan cepat. Sila cuba lagi.",
  "err.BOOKING_NOT_FOUND": "Tempahan tidak dijumpai.",
  "err.BOOKING_NOT_FOUND_CODE": "Tempahan tidak dijumpai. Semak kod dan nombor telefon.",
  "err.ALREADY_CANCELLED": "Tempahan ini sudah dibatalkan.",
  "err.BOOKING_WAS_CANCELLED": "Tempahan ini telah dibatalkan.",
  "err.KIT_STILL_OUT":
    "Peralatan bagi tempahan ini masih belum dipulangkan. Pulangkan ke kaunter dahulu.",
  "err.SERIES_NOT_FOUND": "Siri tidak dijumpai. Semak kod siri dan nombor telefon.",
  "err.SERIES_NONE_LEFT_one":
    "Tiada sesi lagi yang boleh dibatalkan — selebihnya bermula dalam masa {n} jam.",
  "err.SERIES_NONE_LEFT_other":
    "Tiada sesi lagi yang boleh dibatalkan — selebihnya bermula dalam masa {n} jam.",
  "err.CLASS_NOT_FOUND": "Kelas tidak dijumpai.",
  "err.CLASS_FULL": "Kelas ini penuh.",
  "err.CLASS_STARTED": "Kelas ini sudah bermula.",
  "err.CLASS_CANCELLED": "Kelas ini telah dibatalkan.",
  "err.ALREADY_ENROLLED": "Anda sudah berdaftar dalam kelas ini.",
  "err.CLASS_HAS_PLACES": "Kelas ini masih ada tempat — daftar terus sahaja.",
  "err.ALREADY_WAITING": "Anda sudah berada dalam senarai menunggu ini.",
  "err.SLOT_FREE_BOOK_IT": "Waktu itu kosong — tempah terus sahaja.",
  "err.OFFER_EXPIRED": "Tawaran ini telah luput atau sudah dituntut.",
  "err.OFFER_INVALID": "Tawaran ini tidak lagi sah.",
  "err.PLACE_ALREADY_CLAIMED": "Tempat ini sudah dituntut.",
  "err.WAITLIST_NOT_FOUND": "Penyertaan senarai menunggu tidak dijumpai.",
  "err.NOT_ENOUGH_CREDIT": "Kredit tidak mencukupi. Tambah nilai di kaunter atau bayar di sana.",
  "err.NO_ACCOUNT_TO_CHARGE": "Tempahan ini tiada akaun untuk dicaj.",
  "err.ALREADY_PAID": "Tempahan ini sudah dibayar.",
  "err.PASS_NOT_FOUND": "Pas tidak dijumpai.",
  "err.PASS_WRONG_PHONE": "Pas itu milik nombor telefon yang lain.",
  "err.PROMO_ALREADY_USED": "Satu kod sudah digunakan pada tempahan ini.",
  "err.PROMO_TOO_LATE": "Tempahan ini sudah dibayar; kod tidak boleh ditambah sekarang.",
  "passes.counterNote":
    "Beli pas atau keahlian di kaunter? Minta pusat berkenaan letakkan e-mel akaun anda padanya dan ia akan muncul di sini. Mereka mengesahkan siapa anda secara bersemuka, sesuatu yang halaman ini tidak mampu buat.",
};

/** Exported so a test can hold the two languages against each other. */
export const DICTIONARIES: Record<Locale, Record<Phrase, string>> = { en: EN, ms: MS };

export type Vars = Record<string, string | number>;

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  );
}

export interface T {
  (phrase: Phrase, vars?: Vars): string;
  /** The `_one` or `_other` form, with `{n}` already filled in. */
  plural(stem: string, n: number, vars?: Vars): string;
  locale: Locale;
  /** What this install calls itself. */
  site: string;
}

/**
 * The name of a refusal the customer can be shown.
 *
 * Derived from the dictionary rather than written out again: a code exists
 * exactly when there is something to say for it, in both languages, and
 * misspelling one in the store is a compile error rather than an English
 * sentence leaking into a Malay page.
 */
type ErrPhrase<P> = P extends `err.${infer C}` ? C : never;
type Stem<C> = C extends `${infer S}_one` ? S : C extends `${infer S}_other` ? S : C;
export type ErrorCode = Stem<ErrPhrase<Phrase>>;

/** Whether the dictionary has this phrase at all. */
export function hasPhrase(key: string): key is Phrase {
  return key in DICTIONARIES.en;
}

/** The lookup for one language. */
/**
 * The lookup for one language. `{site}` in any phrase is the install's name:
 * on the server that comes from SITE_NAME; in the browser, from the server,
 * through the language provider.
 */
export function translator(locale: Locale, site: string = siteName()): T {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
  const t = ((phrase: Phrase, vars?: Vars) =>
    fill(dict[phrase] ?? String(phrase), { site, ...vars })) as T;
  t.plural = (stem: string, n: number, vars?: Vars) =>
    fill(dict[`${stem}_${n === 1 ? "one" : "other"}` as Phrase] ?? stem, { site, n, ...vars });
  t.locale = locale;
  t.site = site;
  return t;
}

/** What this language calls a sport. The icons are the same either way. */
export function sportLabel(t: T, sport: string): string {
  return t(`sport.${sport}` as Phrase);
}

/**
 * Errors still keyed on their exact English.
 *
 * Everything the store refuses now travels as a code, which `translateError`
 * prefers. What is left here is the handful of refusals written in the route
 * handlers themselves — malformed requests and sign-in failures — which have no
 * code yet. Anything matching neither is shown as it came: an error nobody
 * translated reads oddly, an error nobody shows reads as a blank screen, and
 * the first is much the better failure.
 */
const CUSTOMER_ERRORS_MS: Record<string, string> = {
  // Booking
  "That time has already passed.": "Waktu itu sudah berlalu.",
  "That time slot has already passed.": "Waktu itu sudah berlalu.",
  "That start time has already passed.": "Waktu mula itu sudah berlalu.",
  "That booking has already finished.": "Tempahan itu sudah tamat.",
  "Date is outside the booking window.":
    "Tarikh itu di luar tempoh tempahan yang dibenarkan.",
  "The first date is outside the booking window.":
    "Tarikh pertama itu di luar tempoh tempahan yang dibenarkan.",
  "Select at least one hour.": "Pilih sekurang-kurangnya satu jam.",
  "Selected hours must be consecutive.": "Jam yang dipilih mesti berturut-turut.",
  "Selected hours are outside operating hours.":
    "Jam yang dipilih di luar waktu operasi.",
  "No valid hours given.": "Tiada jam yang sah diberikan.",
  "The venue is closed that day.": "Pusat itu tutup pada hari tersebut.",
  "No court is free for that whole time. Please pick another time.":
    "Tiada gelanggang kosong untuk sepanjang waktu itu. Sila pilih waktu lain.",
  "Every week in that series is already taken. Please pick another slot.":
    "Setiap minggu dalam siri itu sudah ditempah. Sila pilih waktu lain.",
  "That venue has no courts for that sport.":
    "Pusat itu tiada gelanggang untuk sukan tersebut.",
  "Court not found.": "Gelanggang tidak dijumpai.",
  "Venue not found.": "Pusat tidak dijumpai.",
  "Please provide your name.": "Sila berikan nama anda.",
  "Please provide a valid phone number.": "Sila berikan nombor telefon yang sah.",
  "Please provide a valid email address.": "Sila berikan alamat e-mel yang sah.",

  // Finding and cancelling
  "Booking not found.": "Tempahan tidak dijumpai.",
  "Booking not found. Check the code and phone number.":
    "Tempahan tidak dijumpai. Semak kod dan nombor telefon.",
  "Series not found. Check the series code and phone number.":
    "Siri tidak dijumpai. Semak kod siri dan nombor telefon.",
  "This booking is already cancelled.": "Tempahan ini sudah dibatalkan.",
  "This booking was cancelled.": "Tempahan ini telah dibatalkan.",
  "The kit for this booking is still out. Bring it back to the desk first.":
    "Peralatan bagi tempahan ini masih belum dipulangkan. Pulangkan ke kaunter dahulu.",

  // Classes
  "Class not found.": "Kelas tidak dijumpai.",
  "This class is full.": "Kelas ini penuh.",
  "This class has already started.": "Kelas ini sudah bermula.",
  "This class was cancelled.": "Kelas ini telah dibatalkan.",
  "You are already enrolled in this class.": "Anda sudah berdaftar dalam kelas ini.",

  // Waitlist
  "This offer has expired or was already claimed.":
    "Tawaran ini telah luput atau sudah dituntut.",
  "This offer is no longer valid.": "Tawaran ini tidak lagi sah.",
  "This place was already claimed.": "Tempat ini sudah dituntut.",
  "Waitlist entry not found.": "Penyertaan senarai menunggu tidak dijumpai.",
  "That slot is free — book it instead.":
    "Waktu itu kosong — tempah terus sahaja.",

  // Paying
  "Not enough credit. Top up at the counter or pay there.":
    "Kredit tidak mencukupi. Tambah nilai di kaunter atau bayar di sana.",
  "This booking is already paid.": "Tempahan ini sudah dibayar.",
  "This booking is already paid; a code cannot be added now.":
    "Tempahan ini sudah dibayar; kod tidak boleh ditambah sekarang.",
  "This booking has no account to charge.":
    "Tempahan ini tiada akaun untuk dicaj.",
  "A code has already been used on this booking.":
    "Satu kod sudah digunakan pada tempahan ini.",
  "Pass not found.": "Pas tidak dijumpai.",
  "Code not found.": "Kod tidak dijumpai.",
  "That pass belongs to a different phone number.":
    "Pas itu milik nombor telefon yang lain.",

  // Check-in and the door
  "Already checked in.": "Sudah daftar masuk.",
  "Already checked out.": "Sudah daftar keluar.",

  // Signing in
  "Wrong email or password.": "E-mel atau kata laluan salah.",
  "Password must be at least 8 characters.":
    "Kata laluan mesti sekurang-kurangnya 8 aksara.",
  "email and password are required.": "E-mel dan kata laluan diperlukan.",
  "code and phone are required.": "Kod dan nombor telefon diperlukan.",
};

/** What a refused request sends back: the sentence, and the name of the refusal. */
export interface RefusalBody {
  error?: string;
  code?: string;
  vars?: Vars;
}

/**
 * A refused request, in this language.
 *
 * The code is the good path: the store names the refusal and the dictionary
 * says it, with whatever it quotes filled in — so "Maximum 3 hours per booking"
 * reads as "Maksimum 3 jam bagi setiap tempahan" rather than staying English
 * because it happened to have a number in it. A refusal with no code falls back
 * to matching its exact English, and one matching neither is shown as it came.
 */
export function translateError(t: T, body: string | RefusalBody | null | undefined): string {
  const sentence = typeof body === "string" ? body : (body?.error ?? "");
  const code = typeof body === "string" ? undefined : body?.code;
  if (t.locale !== "ms") return sentence;
  if (code && (hasPhrase(`err.${code}`) || hasPhrase(`err.${code}_one`)))
    return errorText(t, code as ErrorCode, typeof body === "string" ? undefined : body?.vars);
  return CUSTOMER_ERRORS_MS[sentence] ?? sentence;
}

/**
 * The sentence for a refusal, in this language.
 *
 * A code whose phrase counts something (`_one` / `_other`) is looked up through
 * `plural` using `vars.n`, so the caller does not have to know which kind it is.
 */
export function errorText(t: T, code: ErrorCode, vars?: Vars): string {
  const key = `err.${code}`;
  if (hasPhrase(key)) return t(key, vars);
  return t.plural(key, Number(vars?.n ?? 0), vars);
}
