import type { CountryCode } from "./region";

/**
 * Public holidays, as gazetted, for a venue to fill its list from in one go
 * rather than typing each one (lib/peak.ts `fillHolidays`).
 *
 * Singapore's are the Ministry of Manpower's list, with the Monday after a
 * holiday on a Sunday. Malaysia's are the federal and state schedule for 2027
 * from the Prime Minister's Department, and what is left of 2026 that every
 * state shares; a state's own days go only to a venue in that state.
 *
 * Islamic holidays and Deepavali are set by sighting and can move by a day
 * once the date is announced: the venue's list is its own, to change. A new
 * year is added here when its schedule is published (in Malaysia, usually
 * mid-year).
 */

export const MY_STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Perak",
  "Perlis",
  "Pulau Pinang",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
  "W.P. Kuala Lumpur",
  "W.P. Labuan",
  "W.P. Putrajaya",
] as const;
export type MyState = (typeof MY_STATES)[number];

interface Entry {
  date: string;
  name: string;
  /** Only in these states; every state when not said. */
  only?: MyState[];
  /** Every state but these. */
  except?: MyState[];
}

const FT: MyState[] = ["W.P. Kuala Lumpur", "W.P. Labuan", "W.P. Putrajaya"];

const MALAYSIA: Entry[] = [
  // What is left of 2026.
  { date: "2026-11-08", name: "Deepavali", except: ["Sarawak"] },
  { date: "2026-12-11", name: "Birthday of the Sultan of Selangor", only: ["Selangor"] },
  { date: "2026-12-25", name: "Christmas Day" },

  // 2027: federal.
  { date: "2027-02-06", name: "Chinese New Year" },
  { date: "2027-02-07", name: "Chinese New Year (second day)" },
  { date: "2027-03-10", name: "Hari Raya Aidilfitri" },
  { date: "2027-03-11", name: "Hari Raya Aidilfitri (second day)" },
  { date: "2027-05-01", name: "Labour Day" },
  { date: "2027-05-17", name: "Hari Raya Haji" },
  { date: "2027-05-18", name: "Hari Raya Haji (second day)", only: ["Kedah", "Kelantan", "Perlis", "Terengganu"] },
  { date: "2027-05-20", name: "Wesak Day" },
  { date: "2027-06-06", name: "Awal Muharram" },
  { date: "2027-06-07", name: "Birthday of the Yang di-Pertuan Agong" },
  { date: "2027-08-15", name: "Maulidur Rasul" },
  { date: "2027-08-31", name: "National Day" },
  { date: "2027-09-16", name: "Malaysia Day" },
  { date: "2027-10-28", name: "Deepavali", except: ["Sarawak"] },
  { date: "2027-12-25", name: "Christmas Day" },

  // 2027: states and federal territories.
  {
    date: "2027-01-01",
    name: "New Year's Day",
    only: ["W.P. Kuala Lumpur", "W.P. Labuan", "W.P. Putrajaya", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Pulau Pinang", "Sabah", "Sarawak", "Selangor"],
  },
  { date: "2027-01-06", name: "Israk and Mikraj", only: ["Kedah", "Negeri Sembilan", "Perlis", "Terengganu"] },
  { date: "2027-01-14", name: "Birthday of the Yang di-Pertuan Besar of Negeri Sembilan", only: ["Negeri Sembilan"] },
  { date: "2027-01-22", name: "Thaipusam", only: ["W.P. Kuala Lumpur", "W.P. Putrajaya", "Negeri Sembilan", "Perak", "Pulau Pinang", "Selangor"] },
  { date: "2027-02-01", name: "Federal Territory Day", only: FT },
  { date: "2027-02-08", name: "Awal Ramadan", only: ["Johor", "Kedah"] },
  { date: "2027-02-20", name: "Declaration of Independence Day", only: ["Melaka"] },
  {
    date: "2027-02-24",
    name: "Nuzul Al-Quran",
    only: ["W.P. Kuala Lumpur", "W.P. Labuan", "W.P. Putrajaya", "Kelantan", "Pahang", "Perak", "Pulau Pinang", "Selangor"],
  },
  { date: "2027-03-04", name: "Anniversary of the Coronation of the Sultan of Terengganu", only: ["Terengganu"] },
  { date: "2027-03-12", name: "Hari Raya Aidilfitri (third day)", only: ["Melaka"] },
  { date: "2027-03-23", name: "Birthday of the Sultan of Johor", only: ["Johor"] },
  { date: "2027-03-26", name: "Good Friday", only: ["Sabah", "Sarawak"] },
  { date: "2027-03-30", name: "Birthday of the Yang di-Pertua Negeri of Sabah", only: ["Sabah"] },
  { date: "2027-05-16", name: "Day of Arafah", only: ["Kelantan", "Terengganu"] },
  { date: "2027-05-17", name: "Birthday of the Raja of Perlis", only: ["Perlis"] },
  { date: "2027-05-22", name: "Hari Hol of Sultan Ahmad Shah", only: ["Pahang"] },
  { date: "2027-05-30", name: "Kaamatan Festival", only: ["Sabah", "W.P. Labuan"] },
  { date: "2027-05-31", name: "Kaamatan Festival (second day)", only: ["Sabah", "W.P. Labuan"] },
  { date: "2027-06-01", name: "Gawai Dayak", only: ["Sarawak"] },
  { date: "2027-06-02", name: "Gawai Dayak (second day)", only: ["Sarawak"] },
  { date: "2027-06-20", name: "Birthday of the Sultan of Kedah", only: ["Kedah"] },
  { date: "2027-07-07", name: "George Town World Heritage Day", only: ["Pulau Pinang"] },
  { date: "2027-07-10", name: "Birthday of the Yang di-Pertua Negeri of Pulau Pinang", only: ["Pulau Pinang"] },
  { date: "2027-07-11", name: "Hari Hol of Sultan Iskandar", only: ["Johor"] },
  { date: "2027-07-22", name: "Sarawak Independence Day", only: ["Sarawak"] },
  { date: "2027-07-30", name: "Birthday of the Sultan of Pahang", only: ["Pahang"] },
  { date: "2027-08-24", name: "Birthday of the Yang di-Pertua Negeri of Melaka", only: ["Melaka"] },
  { date: "2027-09-29", name: "Birthday of the Sultan of Kelantan", only: ["Kelantan"] },
  { date: "2027-09-30", name: "Birthday of the Sultan of Kelantan (second day)", only: ["Kelantan"] },
  { date: "2027-10-09", name: "Birthday of the Yang di-Pertua Negeri of Sarawak", only: ["Sarawak"] },
  { date: "2027-11-05", name: "Birthday of the Sultan of Perak", only: ["Perak"] },
  { date: "2027-12-11", name: "Birthday of the Sultan of Selangor", only: ["Selangor"] },
  { date: "2027-12-24", name: "Christmas Eve", only: ["Sabah"] },
  { date: "2027-12-26", name: "Israk and Mikraj", only: ["Kedah", "Negeri Sembilan", "Perak", "Perlis", "Terengganu"] },
];

const SINGAPORE: Entry[] = [
  { date: "2026-11-08", name: "Deepavali" },
  { date: "2026-11-09", name: "Deepavali (observed)" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-02-06", name: "Chinese New Year" },
  { date: "2027-02-07", name: "Chinese New Year (second day)" },
  { date: "2027-02-08", name: "Chinese New Year (observed)" },
  { date: "2027-03-10", name: "Hari Raya Puasa" },
  { date: "2027-03-26", name: "Good Friday" },
  { date: "2027-05-01", name: "Labour Day" },
  { date: "2027-05-17", name: "Hari Raya Haji" },
  { date: "2027-05-20", name: "Vesak Day" },
  { date: "2027-08-09", name: "National Day" },
  { date: "2027-10-28", name: "Deepavali" },
  { date: "2027-12-25", name: "Christmas Day" },
];

export function isMyState(s: unknown): s is MyState {
  return typeof s === "string" && (MY_STATES as readonly string[]).includes(s);
}

/** The last date the calendar here knows of, so a venue can tell when its list will run out. */
export function calendarUntil(country: CountryCode): string {
  const list = country === "SG" ? SINGAPORE : MALAYSIA;
  return list.reduce((last, e) => (e.date > last ? e.date : last), "");
}

/**
 * The public holidays from `from` on, in date order: a country's, and in
 * Malaysia the state's own too. Malaysia without a state: the days every
 * state keeps.
 */
export function publicHolidays(country: CountryCode, state: MyState | null, from: string): { date: string; name: string }[] {
  const list = country === "SG" ? SINGAPORE : MALAYSIA;
  const kept = (e: Entry) =>
    state === null ? !e.only && !e.except : e.only ? e.only.includes(state) : !e.except?.includes(state);
  // One name a day: where two fall together (Perlis, 17 May 2027), the first listed.
  const byDate = new Map<string, string>();
  for (const e of list) if (e.date >= from && kept(e) && !byDate.has(e.date)) byDate.set(e.date, e.name);
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, name]) => ({ date, name }));
}
