// The word lists the content classifier reads (src/lib/tether/sensitivity.ts), in one place so a
// reviewer can read them. English plus the common Hinglish forms seen in club chats.
// Data only: no logic lives here. Bump CLASSIFIER_VERSION in sensitivity.ts when a list changes.
//
// Conventions: every term is lowercase and matched on whole words. A term ending in "*" matches
// any word that starts with it ("harass*" matches harassed and harassment). A space matches any
// run of whitespace. Possessive 's is removed before matching ("doctor's note" is "doctor note").

export interface CategoryLexicon {
  /** A hit that, with the context a rule asks for, limits the segment by rule. */
  strong: string[];
  /** A hit that alone proves nothing: at most it sends the segment to the model stage. */
  weak: string[];
}

/** Phrases removed before any matching: idioms and equipment talk that only look sensitive. */
export const IGNORE_PHRASES: string[] = [
  // health look-alikes
  "sick of", "fever pitch", "is a headache", "such a headache", "a pain to", "pain to", "killing it",
  "dead battery", "first aid kit", "first aid box", "soldering clinic", "got hot", "burnt out", "burned out",
  "health check", "health checks", "healthcheck", "medical grade",
  // hr look-alikes
  "toxic fumes", "lazy loading", "lazy load", "lazy init",
  // finance look-alikes
  "costs double", "cost double", "free of cost", "price of",
];

// ---------------------------------------------------------------------------------------------
// Finance

/** Words that say money moved between a person and the group, or is owed either way. */
export const FINANCE_CUES: string[] = [
  "owe", "owes", "owed", "dues", "unpaid", "not paid", "has not paid", "have not paid", "hasn't paid",
  "pending from", "refund", "refunded", "penalty", "fine of", "waive", "waived", "waiver", "defaulter",
  "on hold until", "salary", "stipend", "loan", "lent", "borrowed", "paid in cash", "in cash",
  "udhaar", "udhar", "baki", "baaki",
];

/** Verbs that, right after a person, make a payment personal ("<name> paid", "she owes"). */
export const FINANCE_PERSON_VERBS: string[] = ["paid", "pays", "owes", "owed", "owe", "gave", "lent", "borrowed", "deposited", "transferred"];

/** Verbs that, right before a person, make a payment personal ("reimburse her", "refund <name>"). */
export const FINANCE_TO_PERSON_VERBS: string[] = ["reimburse", "reimbursed", "reimbursing", "refund", "refunded", "repay", "repaid", "pay back"];

export const FINANCE_WEAK: string[] = [
  "fee", "fees", "payment", "payments", "budget", "invoice", "invoices", "quote", "quotation",
  "reimbursement", "reimbursements", "reimburse", "reimbursed", "voucher", "vouchers", "ledger",
  "purchase order", "po", "sponsor amount", "sponsorship amount",
];

/** Words that turn a personal-money cue plus a name into a strong hit with no amount (rule F3). */
export const FINANCE_FEE_WORDS: string[] = ["fee", "fees", "dues"];

/** Payment handles after the "@" of a UPI id. An id with another handle needs a payment word nearby. */
export const UPI_HANDLES: string[] = [
  "upi", "ybl", "ibl", "axl", "apl", "paytm", "oksbi", "okhdfcbank", "okicici", "okaxis", "sbi",
  "hdfcbank", "icici", "axisbank", "kotak", "barodampay", "fbl", "idfcbank", "yesbank", "pnb",
];
export const UPI_CONTEXT: string[] = ["upi", "gpay", "google pay", "phonepe", "paytm", "bhim"];

// ---------------------------------------------------------------------------------------------
// HR (people matters)

/** Words that on their own read like a complaint or a disciplinary matter. */
export const HR_CUES: string[] = [
  "complain", "complains", "complained", "complaining", "complaint", "complaints", "grievance", "grievances",
  "harass*", "bully", "bullied", "bullying", "misbehav*", "abusive", "abused", "shouted at", "yelled at",
  "insulted", "insulting", "insults", "humiliat*", "discriminat*", "unfair to", "threatened", "disciplinary",
  "warning letter", "show cause", "suspended from", "suspend him", "suspend her", "kick out", "kicked out",
  "remove from the team", "removed from the team", "or i will leave", "or i quit", "quit the team",
];

/** Softer cues: common in ordinary talk, so one alone never limits a segment. */
export const HR_SOFT_CUES: string[] = ["in front of", "step in", "keeps dismissing", "dismissing my", "dismissed my"];

/** Negative judgements of a person. */
export const HR_JUDGEMENTS: string[] = [
  "useless", "lazy", "incompetent", "not pulling weight", "not pulling his weight", "not pulling her weight",
  "dead weight", "toxic",
];

export const HR_WEAK: string[] = ["attendance", "late again", "dropped from", "removed", "behaviour", "behavior", "attitude"];

// ---------------------------------------------------------------------------------------------
// Health

/** Conditions and treatments. With a person, the segment is limited by rule. */
export const HEALTH_TERMS: string[] = [
  "surgery", "surgeries", "hospital", "hospitalised", "hospitalized", "icu", "diagnosed", "diagnosis",
  "fracture", "fractured", "dengue", "typhoid", "malaria", "covid", "migraine", "asthma", "epilepsy",
  "diabetes", "anxiety", "depression", "panic attack", "panic attacks", "therapy", "therapist",
  "counselling", "counseling", "medication", "prescription", "medical certificate", "doctor note",
  "medical leave", "chemo", "chemotherapy", "pregnant", "miscarriage", "injury", "injured", "stitches",
];

/**
 * Words that are medical only when they belong to a person ("her operation", "my operation").
 * Elsewhere ("operation of the bench robot") they count as weak terms.
 */
export const HEALTH_AMBIGUOUS: string[] = ["operation", "operated"];

export const HEALTH_WEAK: string[] = [
  "sick", "unwell", "not feeling well", "fever", "doctor", "clinic", "medical", "health issue",
  "health issues", "tabiyat", "bukhar", "bimar",
];

// ---------------------------------------------------------------------------------------------
// People and follow-ups

export const FIRST_PERSON: string[] = ["i", "me", "my", "myself"];
export const THIRD_PERSON: string[] = ["he", "she", "him", "her", "his"];
export const FAMILY_WORDS: string[] = [
  "mom", "mum", "mummy", "dad", "papa", "mother", "father", "brother", "sister", "wife", "husband",
  "son", "daughter", "parents", "grandmother", "grandfather",
];

/** Parts of a display name that are never treated as a person's name. */
export const NAME_STOPWORDS: string[] = [
  "mr", "mrs", "ms", "dr", "sir", "madam", "mam", "prof", "professor", "unknown", "bot", "admin", "team",
  "the", "and", "user", "github", "actions", "dependabot",
];

/** In a chat with no reply links, a reply with one of these right after a limited message is checked. */
export const FOLLOW_UP_CUES: string[] = [
  "get well", "take care", "recover", "recovery", "recovering", "sorry to hear", "that is not fair",
  "that not fair", "not fair", "i paid", "you owe", "prove it", "not true",
];

/** Window of the follow-up rule for chats with no reply links. */
export const FOLLOW_UP_MAX_SEGMENTS = 4;
export const FOLLOW_UP_MAX_MINUTES = 20;
/** A judgement term counts against a person named within this many words (rule H2). */
export const JUDGEMENT_NAME_WINDOW = 8;
