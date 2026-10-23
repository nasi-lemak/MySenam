import type { PolicySettings } from "./booking-rules";
import type { CourtFilter } from "./facilities";

/**
 * The activities MySenam knows out of the box (ADR 0011): sports, classes,
 * hire. The engine knows none of them by name. Everything it needs about one
 * — what it is called in each language and country, how it is found in
 * search, what kind of resource it is usually played on, its usual booking
 * rules, and how far its booking workflow is supported — is data here, copied
 * into the `activities` table at start-up (lib/activities.ts), where
 * operators add their own beside them.
 *
 * Browser-safe: no database, only data.
 */

export const ACTIVITY_CATEGORIES = ["racket", "team", "aquatic", "water", "fitness", "studio", "specialist"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/**
 * How an activity's resources are booked, in the engine's own terms:
 * - exclusive: one booking at a time holds the whole of it (a court, a pitch);
 * - lanes: several of the same, each held by one booking ("any lane" books
 *   the cheapest free one); a lane is an exclusive resource;
 * - shared: many people at once, up to its places (a gym floor, a wall);
 * - class: sessions led by an instructor in a room, places sold per person;
 * - hire: a fleet of kit, each booking taking as many as it hires.
 */
export const RESOURCE_MODELS = ["exclusive", "lanes", "shared", "class", "hire"] as const;
export type ResourceModel = (typeof RESOURCE_MODELS)[number];

/** What one resource is called: "Court 1", "Lane 3", "Bay 2". Names in each language are i18n phrases `noun.<key>`. */
export const RESOURCE_NOUNS = [
  "court",
  "pitch",
  "table",
  "lane",
  "bay",
  "piste",
  "net",
  "pool",
  "wall",
  "range",
  "studio",
  "room",
  "ring",
  "mat",
  "floor",
  "station",
  "boat",
  "board",
  "bike",
] as const;
export type ResourceNoun = (typeof RESOURCE_NOUNS)[number];

/**
 * How far an activity's booking workflow is supported. Being in the
 * catalogue proves none of it:
 * - full: everything a venue usually sells for it is bookable with what
 *   exists, and tested;
 * - basic: its resources can be booked and paid for, but something venues
 *   usually sell for it is missing (named in `supportNote`);
 * - specialised: booking time on its resources works, but the way it is
 *   normally sold needs a workflow that is not built (named in `supportNote`).
 */
export const SUPPORT_LEVELS = ["full", "basic", "specialised"] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export type ActivityLocale = "en" | "ms" | "zh" | "ta";
export type ActivityNames = { en: string } & Partial<Record<ActivityLocale, string>>;

/** What a new resource for the activity starts as; the operator changes any of it. */
export interface ActivityTemplate {
  model: ResourceModel;
  noun: ResourceNoun;
  /** Places on one resource: 1 for one booking at a time. */
  capacity: number;
  /** How many to make at once ("8 lanes"). */
  count: number;
  /** Priced per person (or per item hired) rather than per resource. */
  perPlayer: boolean;
  /** The most people, or items, in one booking; null: the platform's limit. */
  maxPlayers: number | null;
  setting: "indoor" | "outdoor" | null;
  /** Customers need a staff sign-off first (a belay check, a range briefing), unless a venue's rules say not. */
  signOff: boolean;
}

/** Where a country names, finds or filters an activity differently. */
export interface CountryVariant {
  names?: Partial<Record<ActivityLocale, string>>;
  aliases?: string[];
  filters?: CourtFilter[];
}

export interface ActivityDefinition {
  key: string;
  category: ActivityCategory;
  icon: string;
  names: ActivityNames;
  /** Other words people search for it by ("ping pong", "SUP"), any language. */
  aliases: string[];
  template: ActivityTemplate;
  /**
   * Its usual booking rules, inherited by every venue offering it unless
   * the venue sets its own (lib/booking-rules.ts `resolvePolicy`).
   */
  policy: PolicySettings;
  /** Played on a surface worth naming (wood, clay, turf). */
  surfaced: boolean;
  /**
   * Never left to run itself, whatever a venue asks for. Drowning is silent
   * and fast, which is why the 24-hour chains sell gym floors and not lap
   * pools; an unstaffed gym is a proven model, and what makes it work is the
   * induction, the emergency button and the equipment.
   */
  supervised: boolean;
  /** The court filters that mean something for it in search. */
  filters: CourtFilter[];
  support: SupportLevel;
  supportNote: string | null;
  country: Partial<Record<string, CountryVariant>>;
}

const t = (model: ResourceModel, noun: ResourceNoun, over: Partial<ActivityTemplate> = {}): ActivityTemplate => ({
  model,
  noun,
  capacity: model === "shared" || model === "class" || model === "hire" ? 20 : 1,
  count: model === "lanes" ? 4 : 1,
  perPlayer: false,
  maxPlayers: null,
  setting: null,
  signOff: false,
  ...over,
});

const COURT_FILTERS_ALL: CourtFilter[] = ["indoor", "outdoor", "aircon", "floodlit"];
const INDOOR: CourtFilter[] = ["aircon"];
const OUTDOOR: CourtFilter[] = ["indoor", "outdoor", "floodlit"];

/** Hourly, from the hour, an hour to four: the platform's own rules. */
const HOURLY: PolicySettings = {};
const halfHours = (defaultLength: number, extra: PolicySettings = {}): PolicySettings => ({
  startEvery: 30,
  lengthStep: 30,
  minLength: 30,
  defaultLength,
  ...extra,
});

/**
 * The built-ins, in the order customers are offered them within a category.
 * Keys never change once released: bookings, courts and policies refer to them.
 */
export const BUILTIN_ACTIVITIES: ActivityDefinition[] = [
  // ------------------------------------------------------------ racket
  {
    key: "badminton",
    category: "racket",
    icon: "🏸",
    names: { en: "Badminton", ms: "Badminton", zh: "羽毛球", ta: "பூப்பந்து" },
    aliases: ["shuttle", "shuttlecock", "bulu tangkis"],
    template: t("exclusive", "court", { setting: "indoor" }),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "tennis",
    category: "racket",
    icon: "🎾",
    names: { en: "Tennis", ms: "Tenis", zh: "网球", ta: "டென்னிஸ்" },
    aliases: [],
    template: t("exclusive", "court", { setting: "outdoor" }),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "pickleball",
    category: "racket",
    icon: "🥒",
    names: { en: "Pickleball", ms: "Pickleball", zh: "匹克球", ta: "பிக்கல்பால்" },
    aliases: [],
    template: t("exclusive", "court"),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "padel",
    category: "racket",
    icon: "🥎",
    names: { en: "Padel", ms: "Padel", zh: "板式网球", ta: "பேடல்" },
    aliases: ["paddle tennis"],
    template: t("exclusive", "court"),
    // Played in 90-minute games, from any half hour.
    policy: { startEvery: 30, lengthStep: 30, minLength: 30, defaultLength: 90 },
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "squash",
    category: "racket",
    icon: "⚫",
    names: { en: "Squash", ms: "Skuasy", zh: "壁球", ta: "ஸ்குவாஷ்" },
    aliases: [],
    template: t("exclusive", "court", { setting: "indoor" }),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "table_tennis",
    category: "racket",
    icon: "🏓",
    names: { en: "Table tennis", ms: "Ping pong", zh: "乒乓球", ta: "மேசைப்பந்து" },
    aliases: ["ping pong", "pingpong"],
    template: t("lanes", "table", { setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  // ------------------------------------------------------------ team
  {
    key: "futsal",
    category: "team",
    icon: "⚽",
    names: { en: "Futsal", ms: "Futsal", zh: "室内足球", ta: "ஃபுட்சல்" },
    aliases: ["5-a-side", "five a side"],
    template: t("exclusive", "court"),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "football",
    category: "team",
    icon: "🥅",
    names: { en: "Football", ms: "Bola sepak", zh: "足球", ta: "கால்பந்து" },
    aliases: ["soccer", "7-a-side", "11-a-side"],
    template: t("exclusive", "pitch", { setting: "outdoor" }),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: OUTDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "basketball",
    category: "team",
    icon: "🏀",
    names: { en: "Basketball", ms: "Bola keranjang", zh: "篮球", ta: "கூடைப்பந்து" },
    aliases: ["3x3"],
    template: t("exclusive", "court"),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "volleyball",
    category: "team",
    icon: "🏐",
    names: { en: "Volleyball", ms: "Bola tampar", zh: "排球", ta: "கைப்பந்து" },
    aliases: ["beach volleyball"],
    template: t("exclusive", "court"),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "netball",
    category: "team",
    icon: "🤾",
    names: { en: "Netball", ms: "Bola jaring", zh: "无板篮球", ta: "வலைப்பந்து" },
    aliases: [],
    template: t("exclusive", "court"),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "floorball",
    category: "team",
    icon: "🏑",
    names: { en: "Floorball", ms: "Floorball", zh: "福乐球", ta: "ஃப்ளோர்பால்" },
    aliases: ["unihockey", "floor hockey"],
    template: t("exclusive", "court", { setting: "indoor" }),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "sepak_takraw",
    category: "team",
    icon: "🦶",
    names: { en: "Sepak takraw", ms: "Sepak takraw", zh: "藤球", ta: "செபக் தக்ராவ்" },
    aliases: ["takraw", "sipa", "kick volleyball"],
    template: t("exclusive", "court"),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: COURT_FILTERS_ALL,
    support: "full",
    supportNote: null,
    country: {
      TH: { names: { en: "Takraw" } },
      PH: { names: { en: "Sipa" } },
    },
  },
  {
    key: "cricket",
    category: "team",
    icon: "🏏",
    names: { en: "Cricket", ms: "Kriket", zh: "板球", ta: "கிரிக்கெட்" },
    aliases: ["cricket nets", "batting cage"],
    template: t("lanes", "net", { count: 3 }),
    policy: HOURLY,
    surfaced: true,
    supervised: false,
    filters: OUTDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  // ------------------------------------------------------------ aquatic
  {
    key: "swimming",
    category: "aquatic",
    icon: "🏊",
    names: { en: "Swimming", ms: "Renang", zh: "游泳", ta: "நீச்சல்" },
    aliases: ["pool", "lap swim", "lane swim"],
    template: t("lanes", "lane", { count: 6, capacity: 4, perPlayer: true }),
    policy: HOURLY,
    surfaced: false,
    supervised: true,
    filters: ["indoor", "outdoor"],
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "water_polo",
    category: "aquatic",
    icon: "🤽",
    names: { en: "Water polo", ms: "Polo air", zh: "水球", ta: "நீர்ப் போலோ" },
    aliases: [],
    template: t("exclusive", "pool"),
    policy: HOURLY,
    surfaced: false,
    supervised: true,
    filters: ["indoor", "outdoor"],
    support: "full",
    supportNote: null,
    country: {},
  },
  // ------------------------------------------------------------ water (paddle and boats)
  {
    key: "kayak",
    category: "water",
    icon: "🛶",
    names: { en: "Kayak hire", ms: "Sewa kayak", zh: "皮划艇租借", ta: "கயாக் வாடகை" },
    aliases: ["kayaking", "kayak rental"],
    template: t("hire", "boat", { capacity: 10, perPlayer: true, maxPlayers: 10, setting: "outdoor" }),
    // As it has always been booked: by the hour (venues may set their own).
    policy: HOURLY,
    surfaced: false,
    supervised: true,
    filters: [],
    support: "basic",
    supportNote: "Hire by the hour, several at once. Guided trips are classes. Not built: choosing a kind or size of boat in one fleet, and tide or launch windows beyond rained-off hours.",
    country: {},
  },
  {
    key: "canoe",
    category: "water",
    icon: "🛶",
    names: { en: "Canoeing", ms: "Berkanu", zh: "划独木舟", ta: "கேனோ படகோட்டம்" },
    aliases: ["canoe hire", "dragon boat"],
    template: t("hire", "boat", { capacity: 8, perPlayer: true, maxPlayers: 8, setting: "outdoor" }),
    policy: halfHours(60, { minLength: 60 }),
    surfaced: false,
    supervised: true,
    filters: [],
    support: "basic",
    supportNote: "Hire by the hour, several at once; guided trips as classes. Not built: boats of different sizes in one fleet, and launch windows.",
    country: {},
  },
  {
    key: "paddleboard",
    category: "water",
    icon: "🏄",
    names: { en: "Stand-up paddleboarding", ms: "Papan dayung berdiri", zh: "立式桨板", ta: "நின்று துடுப்புப் பலகை" },
    aliases: ["SUP", "paddle board", "paddleboarding"],
    template: t("hire", "board", { capacity: 10, perPlayer: true, maxPlayers: 10, setting: "outdoor" }),
    policy: halfHours(60, { minLength: 60 }),
    surfaced: false,
    supervised: true,
    filters: [],
    support: "basic",
    supportNote: "Hire by the hour, several at once; lessons as classes. Not built: board sizes in one fleet, and launch windows.",
    country: {},
  },
  // ------------------------------------------------------------ fitness
  {
    key: "gym",
    category: "fitness",
    icon: "🏋️",
    names: { en: "Gym", ms: "Gim", zh: "健身房", ta: "ஜிம்" },
    aliases: ["fitness", "weights", "gym session"],
    template: t("shared", "floor", { capacity: 30, setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "cycling",
    category: "fitness",
    icon: "🚴",
    names: { en: "Cycling", ms: "Berbasikal", zh: "骑行", ta: "சைக்கிள் ஓட்டுதல்" },
    aliases: ["bike hire", "bicycle", "spin", "indoor cycling"],
    template: t("hire", "bike", { capacity: 12, perPlayer: true, maxPlayers: 6 }),
    policy: halfHours(60, { minLength: 60 }),
    surfaced: false,
    supervised: false,
    filters: ["indoor", "outdoor"],
    support: "basic",
    supportNote: "Bike hire by the hour, several at once, and indoor cycling (spin) as classes. Not built: track or velodrome sessions with heats, and bikes of different sizes in one fleet.",
    country: {},
  },
  // ------------------------------------------------------------ studio (led by an instructor)
  {
    key: "yoga",
    category: "studio",
    icon: "🧘",
    names: { en: "Yoga", ms: "Yoga", zh: "瑜伽", ta: "யோகா" },
    aliases: [],
    template: t("class", "studio", { capacity: 20, setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "pilates",
    category: "studio",
    icon: "🤸",
    names: { en: "Pilates", ms: "Pilates", zh: "普拉提", ta: "பிலாட்டிஸ்" },
    aliases: ["reformer"],
    template: t("class", "studio", { capacity: 10, setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "dance",
    category: "studio",
    icon: "💃",
    names: { en: "Dance", ms: "Tarian", zh: "舞蹈", ta: "நடனம்" },
    aliases: ["zumba", "ballet", "hip hop"],
    template: t("class", "studio", { capacity: 25, setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "martial_arts",
    category: "studio",
    icon: "🥋",
    names: { en: "Martial arts", ms: "Seni mempertahankan diri", zh: "武术", ta: "தற்காப்புக் கலை" },
    aliases: ["silat", "taekwondo", "karate", "judo", "bjj", "muay thai", "wushu"],
    template: t("class", "mat", { capacity: 20, setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "boxing",
    category: "studio",
    icon: "🥊",
    names: { en: "Boxing", ms: "Tinju", zh: "拳击", ta: "குத்துச்சண்டை" },
    aliases: ["kickboxing", "ring hire"],
    template: t("class", "ring", { capacity: 12, setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  // ------------------------------------------------------------ specialist
  {
    key: "climbing",
    category: "specialist",
    icon: "🧗",
    names: { en: "Climbing", ms: "Panjat dinding", zh: "攀岩", ta: "சுவர் ஏறுதல்" },
    aliases: ["rock climbing", "top rope", "lead climbing", "auto belay"],
    template: t("shared", "wall", { capacity: 30, perPlayer: true, maxPlayers: 6, setting: "indoor", signOff: true }),
    policy: halfHours(120, { minLength: 60 }),
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "basic",
    supportNote: "Timed sessions with places, priced per climber, with a belay sign-off asked for unless the venue turns it off. Not built: open-ended day passes with no set time, and route or grade records.",
    country: {},
  },
  {
    key: "bouldering",
    category: "specialist",
    icon: "🪨",
    names: { en: "Bouldering", ms: "Bouldering", zh: "抱石", ta: "பாறை ஏறுதல்" },
    aliases: ["boulder"],
    template: t("shared", "wall", { capacity: 40, perPlayer: true, maxPlayers: 6, setting: "indoor" }),
    policy: halfHours(120, { minLength: 60 }),
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "basic",
    supportNote: "Timed sessions with places, priced per climber. Not built: open-ended day passes with no set time.",
    country: {},
  },
  {
    key: "archery",
    category: "specialist",
    icon: "🏹",
    names: { en: "Archery", ms: "Memanah", zh: "射箭", ta: "வில்வித்தை" },
    aliases: ["archery range", "archery tag"],
    template: t("lanes", "lane", { count: 6, perPlayer: true, maxPlayers: 4, signOff: true }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: ["indoor", "outdoor"],
    support: "basic",
    supportNote: "Lanes by the hour, priced per archer, with a range briefing as a sign-off unless the venue turns it off; lessons as classes. Not built: scheduling a range officer for each session.",
    country: {},
  },
  {
    key: "golf_simulator",
    category: "specialist",
    icon: "⛳",
    names: { en: "Golf simulator", ms: "Simulator golf", zh: "高尔夫模拟器", ta: "கோல்ஃப் சிமுலேட்டர்" },
    aliases: ["golf", "screen golf", "golf bay", "driving range"],
    template: t("lanes", "bay", { count: 2, maxPlayers: 4, setting: "indoor" }),
    policy: halfHours(60, { minLength: 60 }),
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "full",
    supportNote: null,
    country: {},
  },
  {
    key: "bowling",
    category: "specialist",
    icon: "🎳",
    names: { en: "Bowling", ms: "Boling", zh: "保龄球", ta: "பௌலிங்" },
    aliases: ["tenpin", "ten-pin bowling"],
    template: t("lanes", "lane", { count: 8, perPlayer: true, maxPlayers: 6, setting: "indoor" }),
    policy: halfHours(60),
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "specialised",
    supportNote: "Lanes can be hired by time, priced per player, with shoe hire as an extra. Not built: selling by the game, and assigning a lane on arrival.",
    country: {},
  },
  {
    key: "fencing",
    category: "specialist",
    icon: "🤺",
    names: { en: "Fencing", ms: "Lawan pedang", zh: "击剑", ta: "வாள்வீச்சு" },
    aliases: ["epee", "foil", "sabre"],
    template: t("lanes", "piste", { count: 4, setting: "indoor" }),
    policy: HOURLY,
    surfaced: false,
    supervised: false,
    filters: INDOOR,
    support: "basic",
    supportNote: "Pistes by the hour, kit as extras, lessons as classes. Not built: bout scoring and referees.",
    country: {},
  },
];

/** The built-in keys, for what must work before the database is read. */
export const BUILTIN_KEYS: readonly string[] = BUILTIN_ACTIVITIES.map((a) => a.key);
