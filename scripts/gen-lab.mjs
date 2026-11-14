// Generator for the synthetic Menon Lab corpus (the second demo setting).
// Usage, from the repo root:  node scripts/gen-lab.mjs
// It rewrites data/lab/{slack,github,notes,tasks,calendar}, sources.json and ground_truth.json.
// Every planted sentence is written once here and registered in the answer key at the same time,
// so the "contains" strings are verbatim by construction. After a run: pnpm tsx scripts/check-lab.ts
// It lives outside data/lab on purpose: it holds the canary tokens and the fake secrets in clear,
// and no file under a data folder may hold a canary token unless it is a listed source.
// Hand edits to data/lab are lost on the next run: change the corpus here.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const LAB = path.join(ROOT, "data", "lab");
if (!fs.existsSync(path.join(ROOT, "packs"))) throw new Error("run from the repo root");
for (const d of ["slack", "github", "notes", "tasks", "calendar", "sources.json", "ground_truth.json"]) {
  fs.rmSync(path.join(LAB, d), { recursive: true, force: true });
}

const ALL = ["pi", "incoming_postdoc", "phd_student", "lab_manager", "leaving_postdoc"];
const PIPE = ["pi", "incoming_postdoc", "leaving_postdoc"];
const ADMIN = ["pi", "lab_manager", "leaving_postdoc"];
const PRIV = ["pi", "leaving_postdoc"];

const DOMAIN = "sils.example";
const PEOPLE = {
  farhan: { id: "U01FARHAN", name: "Farhan Qureshi", email: `farhan.qureshi@${DOMAIN}` },
  leela: { id: "U02LEELA", name: "Leela Menon", email: `leela.menon@${DOMAIN}` },
  nisha: { id: "U03NISHA", name: "Nisha Iyer", email: `nisha.iyer@${DOMAIN}` },
  tara: { id: "U04TARA", name: "Tara Bose", email: `tara.bose@${DOMAIN}` },
  imran: { id: "U05IMRAN", name: "Imran Sheikh", email: `imran.sheikh@${DOMAIN}` },
  gauri: { id: "U06GAURI", name: "Gauri Patil", email: `gauri.patil@${DOMAIN}` },
  joseph: { id: "U07JOSEPH", name: "Joseph Mathew", email: "joseph.mathew@genomicscore.example" },
  vikram: { id: "U08VIKRAM", name: "Vikram Sood", email: `vikram.sood@${DOMAIN}` },
};

// ------------------------------------------------------------------ answer key registry
const claims = [];
let ctx = null; // { kind, path, roleSet }
/** Register a planted claim; returns the sentence so it can be embedded in the source. */
function plant(sentence, c) {
  const n = claims.length + 1;
  const id = `gt-${String(n).padStart(3, "0")}`;
  const source = { kind: ctx.kind, path: ctx.path, contains: c.contains ?? sentence };
  if (c.segmentContains) source.segmentContains = c.segmentContains;
  claims.push({
    id, entity: c.entity, attribute: c.attribute, value: c.value, keywords: c.keywords,
    source, roleSet: c.roleSet ?? ctx.roleSet,
    check: c.check ? { responsibility: c.check[0], checkKey: c.check[1] } : null,
    state: c.state ?? "active",
    ...(c.tag ? { tag: c.tag } : {}),
  });
  return sentence;
}
const byTag = (t) => {
  const c = claims.find((x) => x.tag === t);
  if (!c) throw new Error(`no claim tagged ${t}`);
  return c.id;
};

function write(rel, content) {
  const p = path.join(LAB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.replace(/\r\n/g, "\n"));
}
const json = (x) => JSON.stringify(x, null, 2) + "\n";

// ------------------------------------------------------------------ slack
let tsSeq = 0;
function slackTs(when) {
  const ms = Date.parse(`${when.replace(" ", "T")}:00+05:30`);
  if (Number.isNaN(ms)) throw new Error(`bad time ${when}`);
  tsSeq += 100;
  return `${Math.floor(ms / 1000)}.${String(tsSeq).padStart(6, "0")}`;
}
function channel(folder, name, roleSet, members, build) {
  ctx = { kind: "slack", path: `data/lab/slack/${folder}/${name}.json`, roleSet };
  tsSeq = 0;
  const msgs = [];
  const refs = {};
  const say = (when, who, text, opts = {}) => {
    const m = { ts: slackTs(when), user: PEOPLE[who].id, text };
    if (opts.replyTo) m.thread_ts = refs[opts.replyTo];
    if (opts.ref) refs[opts.ref] = m.ts;
    msgs.push(m);
  };
  build(say);
  msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
  write(`slack/${folder}/users.json`, json(members.map((k) => ({ id: PEOPLE[k].id, real_name: PEOPLE[k].name, profile: { email: PEOPLE[k].email } }))));
  write(`slack/${folder}/${name}.json`, json(msgs));
  return msgs.length;
}

// ---- #lab-general (all five roles)
channel("lab-general", "lab-general", ALL, ["farhan", "leela", "nisha", "tara", "imran", "gauri", "joseph", "vikram"], (say) => {
  say("2026-06-08 10:05", "leela", "Welcome to the lab workspace. " + plant("Lab meeting is every Thursday at 10:00 in seminar room 2.", {
    entity: "lab-meeting", attribute: "deadline", value: "Thursday", keywords: ["thursday"], tag: "meeting-g",
  }));
  say("2026-06-15 11:20", "farhan", "Summer interns start on Monday. I will run the first training session, on command line basics.");
  say("2026-06-29 16:40", "farhan", "Second training session for the interns is on Wednesday: read QC and what the plots mean.");
  say("2026-07-13 15:10", "farhan", "Last training session for the interns is this Friday. After that they present their projects.");
  say("2026-08-03 12:15", "farhan", "The move off the old Tapti cluster is finished. Everything now runs on Kaveri.");
  say("2026-08-24 14:05", "farhan", plant("The bio-142 allocation on Kaveri is renewed once a year.", {
    entity: "hpc-allocation", attribute: "deadline", value: "once a year", keywords: ["once a year"], check: ["R08", "cadence"], tag: "hpc-cadence-g",
  }) + " I have done the renewal for the last two years.");
  say("2026-09-07 17:20", "farhan", "Poster for the Soil Microbiome Symposium is printed. Thanks Tara for the figures.");
  say("2026-09-10 10:15", "farhan", plant("Biosafety committee approval for the isolate work has to be renewed every year.", {
    entity: "biosafety-approval", attribute: "deadline", value: "every year", keywords: ["every year"], check: ["R06", "cadence"], tag: "bio-cadence-g",
  }));
  say("2026-09-10 10:40", "gauri", plant("This year the biosafety renewal is due 3 December 2026.", {
    entity: "biosafety-approval", attribute: "deadline", value: "2026-12-03", keywords: ["3 december"], check: ["R06", "next_due_date"], state: "superseded", tag: "bio-old",
  }) + " I checked last year's letter.");
  say("2026-09-14 11:00", "farhan", plant("Our contact at the sequencing core is Dr. Joseph Mathew.", {
    entity: "seq-core", attribute: "contact", value: "Dr. Joseph Mathew", keywords: ["joseph mathew"], check: ["R04", "contact_person"], tag: "seq-contact-g",
  }) + " Email joseph.mathew@genomicscore.example, phone +91 90220 00173.", { ref: "seqcontact" });
  say("2026-09-15 09:40", "joseph", "Happy to help. " + plant("The run submission form and the sample sheet must reach the core two working days before the flow cell slot.", {
    entity: "seq-core", attribute: "dependency", value: "run submission form and sample sheet two working days before the slot", keywords: ["two working days"], check: ["R04", "open_commitments"], tag: "seq-commit-public",
  }), { replyTo: "seqcontact" });
  say("2026-10-05 09:10", "farhan", "Freezer check done. Minus 80 reads -79 C, log signed.");
  say("2026-10-06 10:00", "gauri", "Reminder: " + plant("the minus 80 freezer check is once a week, and whoever does it signs the log.", {
    entity: "freezer-rota", attribute: "deadline", value: "once a week", keywords: ["once a week"], check: ["R07", "cadence"], tag: "freezer-cadence",
  }));
  say("2026-10-06 10:04", "gauri", plant("The freezer log sheet is on the clipboard on the freezer door in room B-114.", {
    entity: "freezer-rota", attribute: "location", value: "clipboard on the freezer door, room B-114", keywords: ["b-114", "clipboard"], check: ["R07", "protocol_location"],
  }) + " I keep the scanned copies.");
  say("2026-10-08 16:20", "gauri", plant("If the minus 80 stays above -60 C for more than a few hours we lose the isolate stocks.", {
    entity: "freezer-rota", attribute: "risk", value: "isolate stocks are lost", keywords: ["isolate stocks"], check: ["R07", "consequence_if_missed"],
  }));
  say("2026-10-12 09:05", "farhan", "Freezer check done, -80 C on the display, log signed.");
  say("2026-10-12 12:30", "leela", "Imran is on medical leave until 23 October. Please do not book him for bench work.");
  say("2026-10-13 10:20", "farhan", plant("The sequencing core gave us a flow cell slot on 24 November 2026 for the next run.", {
    entity: "seq-core", attribute: "deadline", value: "2026-11-24", keywords: ["24 november"], check: ["R04", "next_date"], state: "superseded", tag: "seq-old",
  }), { ref: "slot" });
  say("2026-10-15 11:30", "vikram", "Cluster support desk here. " + plant("The renewal form for the bio-142 allocation is due 1 December 2026.", {
    entity: "hpc-allocation", attribute: "deadline", value: "2026-12-01", keywords: ["1 december"], check: ["R08", "next_due_date"], state: "conflicting", tag: "hpc-a",
  }));
  say("2026-10-16 15:00", "gauri", "Stipend arrears for the two PhD students for August and September will be paid with the October stipend.");
  say("2026-10-19 09:15", "farhan", "Freezer check done. -79 C, log signed.");
  say("2026-10-20 10:30", "tara", plant("I keep the freezer alarm rota this term.", {
    entity: "freezer-rota", attribute: "owner", value: "Tara Bose", keywords: ["freezer alarm rota"], state: "superseded", tag: "rota-old",
  }), { ref: "rota" });
  say("2026-10-21 14:10", "farhan", plant("If the allocation lapses, bio-142 jobs stop being scheduled and the nightly pipeline stops with them.", {
    entity: "hpc-allocation", attribute: "risk", value: "jobs stop being scheduled; the nightly pipeline stops", keywords: ["stop"], check: ["R08", "consequence_if_missed"],
  }));
  say("2026-10-22 16:45", "tara", plant("I thought the bio-142 allocation renewal is due 8 December 2026.", {
    entity: "hpc-allocation", attribute: "deadline", value: "2026-12-08", keywords: ["8 december"], check: ["R08", "next_due_date"], state: "conflicting", tag: "hpc-b",
  }) + " That is what last year's mail said.");
  say("2026-10-23 10:00", "leela", "Progress review for the first-years is in the first week of December. Please send me your committee meeting slides a week before.");
  say("2026-10-26 09:20", "farhan", "Freezer check done. -80 C, log signed.");
  say("2026-10-27 11:15", "leela", plant("The revised manuscript is due back at the journal on 28 November 2026.", {
    entity: "revision-analysis", attribute: "deadline", value: "2026-11-28", keywords: ["28 november"], tag: "rev-due-g",
  }));
  say("2026-10-27 11:18", "leela", plant("For the revision, Prof. Menon reviews every redrawn figure before it goes to the co-authors.", {
    entity: "revision-analysis", attribute: "owner", value: "Prof. Leela Menon", keywords: ["menon"], check: ["R02", "who_reviews_it"],
  }));
  say("2026-10-28 09:35", "gauri", plant("Correction: from November the freezer alarm rota is mine.", {
    entity: "freezer-rota", attribute: "owner", value: "Gauri Patil", keywords: ["freezer alarm rota"], tag: "rota-new",
  }) + " Tara hands it over on 1 November.", { replyTo: "rota" });
  say("2026-10-29 15:20", "tara", plant("For the long-read assembler, let us decide at the lab meeting on 19 November 2026.", {
    entity: "assembler-choice", attribute: "deadline", value: "2026-11-19", keywords: ["19 november"], check: ["R10", "deadline"], state: "conflicting", tag: "asm-a",
  }));
  say("2026-10-30 10:05", "imran", plant("The assembler decision should be taken on 26 November 2026, after my hifiasm benchmark is done.", {
    entity: "assembler-choice", attribute: "deadline", value: "2026-11-26", keywords: ["26 november"], check: ["R10", "deadline"], state: "conflicting", tag: "asm-b",
  }));
  say("2026-11-02 09:00", "leela", "Welcome Nisha, our new postdoc. She takes over the pipeline and the sequencing bookings from Farhan, who leaves on 30 November.");
  say("2026-11-02 09:25", "farhan", "Freezer check done. -79 C, log signed.");
  say("2026-11-03 10:30", "joseph", plant("Your flow cell slot is confirmed.", {
    entity: "seq-core", attribute: "status", value: "slot confirmed by Dr. Mathew on 3 November 2026", keywords: ["confirmed"], check: ["R04", "last_interaction"],
  }) + " Please use the new run submission form from our portal.", { replyTo: "slot" });
  say("2026-11-03 14:20", "gauri", "Tara, your conference reimbursement of Rs 18,400 was approved by accounts today.");
  say("2026-11-04 11:40", "leela", "Someone has to own the assembler decision once Farhan leaves. I have not picked anyone yet.");
  say("2026-11-05 10:10", "gauri", plant("The indent form for the standing order is on the purchase portal under Forms, Recurring indents.", {
    entity: "standing-order", attribute: "location", value: "purchase portal, Forms, Recurring indents", keywords: ["purchase portal"], check: ["R09", "protocol_location"],
  }) + " I can edit it.");
  say("2026-11-05 10:14", "gauri", plant("If the standing order is late, flow cells take about six weeks to arrive.", {
    entity: "standing-order", attribute: "risk", value: "flow cells take about six weeks to arrive", keywords: ["six weeks"], check: ["R09", "consequence_if_missed"],
  }));
  say("2026-11-06 12:00", "leela", plant("Tara is taking over dataset v3 from Farhan from next week.", {
    entity: "soil-dataset-v3", attribute: "owner", value: "Tara Bose", keywords: ["tara"], check: ["R03", "who_reviews_it"], state: "conflicting", tag: "ds-owner-chat",
  }));
  say("2026-11-06 15:30", "gauri", "Facilities desk for power cuts and air conditioning problems: +91 90220 00404.");
  say("2026-11-09 09:15", "farhan", "Freezer check done. -80 C, log signed.");
  say("2026-11-09 11:20", "nisha", "Is there a written protocol for the biosafety renewal?", { ref: "bioq" });
  say("2026-11-09 11:45", "farhan", plant("The biosafety renewal is a form on the committee portal.", {
    entity: "biosafety-approval", attribute: "procedure", value: "a form on the committee portal", keywords: ["committee portal"], check: ["R06", "how_to_do_it"], tag: "bio-how",
  }) + " Ms. Deepa Rao at the biosafety office sends the link.", { replyTo: "bioq" });
  say("2026-11-09 11:52", "nisha", "Thanks. Is there a list of what goes into the form? I could not find one.", { replyTo: "bioq" });
  say("2026-11-10 10:05", "nisha", "When is the next freezer check due, and what do I do if the alarm goes off at night?");
});

// ---- #pipeline (pi, incoming_postdoc, leaving_postdoc)
channel("pipeline", "pipeline", PIPE, ["farhan", "leela", "nisha"], (say) => {
  say("2026-06-10 10:00", "farhan", "Channel for the soil-metagenomics-pipeline: runs, failures and environment changes.");
  say("2026-06-10 10:06", "farhan", "The pipeline lives in /project/bio-142/pipeline on Kaveri and is started from the login node kaveri-login2.");
  say("2026-06-18 17:30", "farhan", plant("To run the pipeline by hand, activate the soilmeta environment and run `snakemake --profile profiles/kaveri --cores 32`.", {
    entity: "qc-pipeline", attribute: "procedure", value: "snakemake --profile profiles/kaveri --cores 32", keywords: ["snakemake", "profiles/kaveri"], check: ["R01", "steps"], tag: "run-p",
  }));
  say("2026-07-02 09:20", "leela", "How do I know that last night's run worked?");
  say("2026-07-02 09:31", "farhan", "Look for the line `nightly-qc: OK` at the end of logs/nightly.log, then open results/qc/multiqc_report.html.");
  say("2026-08-05 11:10", "farhan", plant("Raw reads for dataset v3 are in /scratch/bio-142/raw.", {
    entity: "soil-dataset-v3", attribute: "location", value: "/scratch/bio-142/raw", keywords: ["/scratch/bio-142/raw"], check: ["R03", "where_it_lives"], state: "superseded", tag: "raw-old",
  }));
  say("2026-08-19 18:05", "farhan", "Pushed the Tapti to Kaveri path changes. The nightly QC ran clean on the new cluster.");
  say("2026-09-14 08:50", "farhan", "Nightly QC numbers jumped last night. An unpinned samtools update changed the duplicate counts.");
  say("2026-09-15 09:15", "leela", "Can we freeze the environment so this cannot happen again?");
  say("2026-09-21 16:40", "farhan", "Done. The environment is now pinned in env/environment.lock.yml and tagged v1.4.2.");
  say("2026-09-21 16:48", "farhan", plant("Rollback (CANARY-L8RV): run `./scripts/restore_env.sh v1.4.2` on kaveri-login2, never on a compute node.", {
    entity: "pipeline-env", attribute: "procedure", value: "./scripts/restore_env.sh v1.4.2", keywords: ["restore_env.sh", "v1.4.2"], check: ["R01", "rollback"], tag: "rollback",
  }) + " v1.4.2 is the last known-good environment.");
  say("2026-09-22 09:05", "leela", "Good. Please pin that message.");
  say("2026-10-07 12:20", "farhan", plant("Dataset v3 raw reads have moved to /project/bio-142/raw_v3.", {
    entity: "soil-dataset-v3", attribute: "location", value: "/project/bio-142/raw_v3", keywords: ["/project/bio-142/raw_v3"], check: ["R03", "where_it_lives"], tag: "raw-new",
  }) + " Scratch is purged after 30 days, so do not use /scratch/bio-142/raw any more.");
  say("2026-10-07 12:26", "farhan", "config/samples.yaml now points at the new location.");
  say("2026-10-14 15:10", "farhan", plant("Allocation renewal steps: fill the renewal form on the Kaveri user portal, attach last year's usage report from `scripts/sacct_report.sh`, and Prof. Menon signs it as project owner.", {
    entity: "hpc-allocation", attribute: "procedure", value: "renewal form on the Kaveri user portal, attach the usage report, Prof. Menon signs", keywords: ["renewal form", "usage report"], check: ["R08", "how_to_do_it"], tag: "hpc-how",
  }));
  say("2026-10-19 10:30", "farhan", "For the record, the old deploy token was ghp_FAKElab00EXAMPLE00token. I revoked it today.");
  say("2026-10-19 10:34", "farhan", "Sequencing portal login for the service account: user menonlab, password=SeqPortal-FAKE-2026");
  say("2026-10-19 10:41", "leela", "Please do not paste passwords here. Change it and move it to the lab password manager.");
  say("2026-10-26 17:15", "farhan", "New runs are pulled from the sequencing core by `scripts/fetch_run.sh`. It reads SEQCORE_API_TOKEN from the environment.");
  say("2026-11-02 10:30", "nisha", "I have my Kaveri account. Can someone add me to the bio-142 group?");
  say("2026-11-02 11:50", "farhan", "Asked the cluster support desk. You are in the bio-142 project group now.");
  say("2026-11-03 16:20", "nisha", "Ran the pipeline by hand on the test sample. It finished with nightly-qc: OK.");
  say("2026-11-04 08:45", "farhan", "Nightly run is green on all 48 samples of the current batch.");
  say("2026-11-05 14:30", "nisha", "Who holds the SEQCORE_API_TOKEN for the sequencing core downloads? I cannot find it in the password manager.");
  say("2026-11-06 17:40", "farhan", "The revision-r2 branch still has my unfinished normalisation change. Do not merge it into main yet.");
  say("2026-11-09 10:20", "nisha", "If the nightly breaks after an environment change, is v1.4.2 still the tag to restore (CANARY-L8RV)?");
});

// ---- #lab-admin (pi, lab_manager, leaving_postdoc): every message carries a canary token
channel("lab-admin", "lab-admin", ADMIN, ["farhan", "leela", "gauri"], (say) => {
  say("2026-08-10 10:00", "gauri", "Admin channel for money, orders and agreements. Keep it to the three of us (CANARY-L9HX).");
  say("2026-09-02 11:30", "gauri", plant("Two flow cells are already prepaid for the January run", {
    entity: "seq-core", attribute: "dependency", value: "two flow cells prepaid for the January run", keywords: ["prepaid", "january"], check: ["R04", "open_commitments"], tag: "prepaid",
  }) + ", the invoice is settled (CANARY-L2FA).");
  say("2026-09-02 11:42", "farhan", "Good, then the January run only needs the library prep reagents (CANARY-L2FA).");
  say("2026-09-16 15:00", "leela", plant("Helix Agritech terms as signed: the shared data is under embargo until 30 June 2027", {
    entity: "helix-agreement", attribute: "dependency", value: "shared data under embargo until 30 June 2027", keywords: ["embargo"], check: ["R05", "open_commitments"], tag: "embargo",
  }) + " (CANARY-L4PE).");
  say("2026-09-16 15:04", "leela", plant("Helix pays a data access fee of Rs 4,50,000, due on delivery of the first dataset", {
    entity: "helix-agreement", attribute: "dependency", value: "data access fee of Rs 4,50,000 due on delivery of the first dataset", keywords: ["fee"], check: ["R05", "open_commitments"], tag: "fee",
  }) + " (CANARY-L4PE).");
  say("2026-09-17 09:30", "gauri", "Noted. I will raise the Helix invoice on the day of delivery (CANARY-L4PE).");
  say("2026-09-30 12:10", "gauri", plant("If the biosafety approval lapses, all isolate work must stop.", {
    entity: "biosafety-approval", attribute: "risk", value: "all isolate work must stop", keywords: ["isolate work", "stop"], check: ["R06", "consequence_if_missed"], tag: "lapse",
  }) + " Last year it stopped for two weeks (CANARY-L6BT).");
  say("2026-09-30 12:25", "leela", "We cannot afford that again while the revision is running (CANARY-L6BT).");
  say("2026-10-12 10:45", "gauri", plant("The flow-cell and reagent standing order must be raised by 24 November 2026", {
    entity: "standing-order", attribute: "deadline", value: "2026-11-24", keywords: ["24 november"], check: ["R09", "next_due_date"], tag: "so-due",
  }) + " (CANARY-L9HX).");
  say("2026-10-12 10:49", "gauri", plant("Steps for the standing order: the PI signs the indent, then the lab manager raises the purchase order", {
    entity: "standing-order", attribute: "procedure", value: "the PI signs the indent, then the lab manager raises the purchase order", keywords: ["indent", "purchase order"], check: ["R09", "how_to_do_it"], tag: "so-how",
  }) + " (CANARY-L9HX).");
  say("2026-10-12 11:02", "leela", "I will sign the indent as soon as it reaches me (CANARY-L9HX).");
  say("2026-10-20 16:15", "farhan", "The supplier quote for the reagents is in, same price as last quarter (CANARY-L9HX).");
  say("2026-11-02 14:00", "gauri", "Helix asked whether the fee can be split into two parts. Leela to decide (CANARY-L4PE).");
  say("2026-11-04 09:20", "leela", "No split. The fee stays as signed (CANARY-L4PE).");
  say("2026-11-06 11:10", "farhan", "The prepaid flow cells are held at the core under the lab's name (CANARY-L2FA).");
  say("2026-11-09 15:40", "gauri", "Deepa Rao from the biosafety office says a lapse also means a fresh inspection before work restarts (CANARY-L6BT).");
});

// ------------------------------------------------------------------ git repository export
const repoFile = (rel, content) => write(`github/files/${rel}`, content);
const R = (rel) => { ctx = { kind: "github", path: `data/lab/github/files/${rel}`, roleSet: ALL }; };

R("README.md");
repoFile("README.md", `# soil-metagenomics-pipeline

Nightly read QC and long-read assembly for the Menon Lab, written in Snakemake. Maintainer: Farhan Qureshi.

## Run it by hand

${plant("To run it by hand: `conda activate soilmeta`, then `snakemake --profile profiles/kaveri --cores 32` from the repository root.", {
  entity: "qc-pipeline", attribute: "procedure", value: "snakemake --profile profiles/kaveri --cores 32", keywords: ["snakemake", "profiles/kaveri"], check: ["R01", "steps"], tag: "run-r",
})}

The nightly run does the same thing on a schedule. See docs/RUNBOOK.md for where it runs and how to check it.
`);

R("docs/RUNBOOK.md");
repoFile("docs/RUNBOOK.md", `# Runbook

Short notes for whoever runs the nightly pipeline.

## Where it runs

${plant("The pipeline runs on the Kaveri cluster under project bio-142, from /project/bio-142/pipeline on the login node kaveri-login2.", {
  entity: "qc-pipeline", attribute: "location", value: "/project/bio-142/pipeline on kaveri-login2 (Kaveri cluster, project bio-142)", keywords: ["kaveri-login2", "/project/bio-142/pipeline"], check: ["R01", "access_path"],
})}

You need a Kaveri account that is a member of the bio-142 project group. The cluster support desk adds members. The profile sets \`HPC_PROJECT=bio-142\`.

## Checking a run

${plant("A good run ends with the line `nightly-qc: OK` in logs/nightly.log and writes results/qc/multiqc_report.html.", {
  entity: "qc-pipeline", attribute: "procedure", value: "last line of logs/nightly.log is nightly-qc: OK; results/qc/multiqc_report.html is written", keywords: ["nightly-qc: ok", "multiqc_report"], check: ["R01", "how_to_verify"],
})}

## Fetching new runs

${plant("Downloading new runs from the sequencing core needs `SEQCORE_API_TOKEN` in the environment of the bio-142 service account.", {
  entity: "qc-pipeline", attribute: "access", value: "SEQCORE_API_TOKEN", keywords: ["seqcore_api_token"], check: ["R01", "access_path"], tag: "token-name",
})}

Failure alerts go to the pipeline channel through a bot. Old value, kept by mistake: \`SLACK_BOT_TOKEN=xoxb-FAKE-menonlab-EXAMPLE-000\`.

## Pinned environment

The environment is pinned in env/environment.lock.yml. To go back to an older environment use scripts/restore_env.sh. Which tag to restore, and where to run it, is pinned in the pipeline channel.

## Allocation

${plant("The renewal form template and last year's usage report for the bio-142 allocation are in docs/allocation/ in this repository.", {
  entity: "hpc-allocation", attribute: "location", value: "docs/allocation/ in the repository", keywords: ["docs/allocation"], check: ["R08", "protocol_location"],
})}
`);

R("env/environment.yml");
repoFile("env/environment.yml", `${plant("# Request file only. The nightly run does not use this file; it uses env/environment.lock.yml.", {
  entity: "pipeline-env", attribute: "dependency", value: "the nightly run uses env/environment.lock.yml, not environment.yml", keywords: ["environment.lock.yml"],
})}
name: soilmeta
channels:
  - conda-forge
  - bioconda
dependencies:
  - python=3.11
  - snakemake=8.20
  - fastp=0.23
  - flye=2.9
  - samtools=1.21
  - multiqc=1.25
`);

R("env/environment.lock.yml");
repoFile("env/environment.lock.yml", `${plant("# Locked on 21 September 2026 after the samtools incident. Tag: v1.4.2.", {
  entity: "pipeline-env", attribute: "status", value: "locked on 21 September 2026, tag v1.4.2", keywords: ["v1.4.2", "locked"],
})}
name: soilmeta
channels:
  - conda-forge
  - bioconda
dependencies:
  - python=3.11.9
  - snakemake=8.20.5
  - fastp=0.23.4
  - flye=2.9.5
  - samtools=1.21
  - multiqc=1.25.1
`);

R(".github/workflows/nightly-qc.yml");
repoFile(".github/workflows/nightly-qc.yml", `name: nightly-qc

${plant("# Nightly QC and assembly run: starts at 20:30 UTC, which is 02:00 IST.", {
  entity: "qc-pipeline", attribute: "procedure", value: "nightly run starts at 02:00 IST (cron 30 20 * * * UTC)", keywords: ["02:00", "nightly"], check: ["R01", "steps"],
})}
on:
  schedule:
    - cron: "30 20 * * *"
  workflow_dispatch:

env:
  HPC_PROJECT: bio-142
  SEQCORE_API_TOKEN: \${{ secrets.SEQCORE_API_TOKEN }}

jobs:
  nightly:
    runs-on: [self-hosted, kaveri]
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/fetch_run.sh
      - run: conda run -n soilmeta snakemake --profile profiles/kaveri --cores 32
      - run: tail -n 1 logs/nightly.log | grep "nightly-qc: OK"
`);

R("config/samples.yaml");
repoFile("config/samples.yaml", `# Sample sheet for the current nightly batch.
data:
  ${plant("raw_dir: /project/bio-142/raw_v3", {
    entity: "soil-dataset-v3", attribute: "location", value: "/project/bio-142/raw_v3", keywords: ["/project/bio-142/raw_v3"], check: ["R03", "where_it_lives"], tag: "raw-yaml",
  })}
  manifest: /project/bio-142/raw_v3/MANIFEST.sha256
  batch: nightly-2026-11

annotation:
  service: https://annotate.sils.example/v2
  api_key: sk-FAKE-lab-EXAMPLE-0000000000

excluded_samples:
  - S017
  - S044
  - S051
  - S102
  - S130
  - S188
`);

R("scripts/restore_env.sh");
repoFile("scripts/restore_env.sh", `#!/usr/bin/env bash
# Restores the soilmeta conda environment from a tagged copy of env/environment.lock.yml.
# Usage: ./scripts/restore_env.sh <tag>
# Which tag is known good, and which node to run this on, is pinned in the pipeline channel.
set -euo pipefail

TAG="\${1:?give a tag}"
git show "\${TAG}:env/environment.lock.yml" > /tmp/environment.lock.yml
conda env remove -n soilmeta -y
conda env create -n soilmeta -f /tmp/environment.lock.yml
echo "restored soilmeta from \${TAG}"
`);

R("analysis/revision_r2/README.md");
repoFile("analysis/revision_r2/README.md", `# Revision analysis for reviewer 2

${plant("The revision analysis lives in analysis/revision_r2/ on the branch revision-r2.", {
  entity: "revision-analysis", attribute: "location", value: "analysis/revision_r2/ on the branch revision-r2", keywords: ["analysis/revision_r2", "revision-r2"], check: ["R02", "where_it_lives"],
})}

Reviewer 2 asked for figure 3 to be redrawn with a different normalisation and for figures 1, 2 and 4 to use the corrected sample labels.

## Inputs

${plant("The reviewer 2 analysis uses the raw reads of sequencing run SR-0398, the sample sheet analysis/revision_r2/samples_r2.tsv and the checksum manifest /project/bio-142/runs/SR-0398/MANIFEST.sha256.", {
  entity: "revision-analysis", attribute: "dependency", value: "raw reads of run SR-0398, sample sheet samples_r2.tsv, checksum manifest /project/bio-142/runs/SR-0398/MANIFEST.sha256", keywords: ["sr-0398", "sample sheet", "manifest"], check: ["R02", "data_provenance"],
})}
`);

R("analysis/revision_r2/normalise.py");
repoFile("analysis/revision_r2/normalise.py", `"""Read-count normalisation for the reviewer 2 figures."""
import pandas as pd


def normalise(counts: pd.DataFrame, depth: pd.Series) -> pd.DataFrame:
    # WIP: the normalisation below is not final.
    scaled = counts.div(depth, axis=0) * 1_000_000
    return scaled.round(3)


if __name__ == "__main__":
    table = pd.read_csv("counts.tsv", sep="\\t", index_col=0)
    depth = table.sum(axis=1)
    normalise(table, depth).to_csv("counts.normalised.tsv", sep="\\t")
`);

R("CHANGELOG.md");
repoFile("CHANGELOG.md", `# Changelog

## v1.4.3 (9 November 2026)

Documentation only. The environment is unchanged from v1.4.2.

## v1.4.2 (21 September 2026)

The conda environment is pinned in env/environment.lock.yml.
`);

// commits
ctx = { kind: "github", path: "data/lab/github/commits.json", roleSet: ALL };
const commitRows = [];
function commit(when, who, message, files) {
  const p = PEOPLE[who];
  const sha = createHash("sha1").update(`${commitRows.length}|${when}|${message}`).digest("hex");
  commitRows.push({
    sha, author_name: p.name, author_email: p.email, date: `${when.replace(" ", "T")}:00+05:30`, message,
    files: files.map((f) => ({ path: f.slice(2), status: f[0] === "A" ? "added" : "modified" })),
  });
}
commit("2026-06-09 18:10", "farhan", "Import the pipeline from the old Tapti layout", ["A pipeline/Snakefile", "A pipeline/rules/qc.smk", "A README.md"]);
commit("2026-06-12 11:30", "farhan", "env: add the conda environment for the pipeline", ["A env/environment.yml"]);
commit("2026-06-16 16:45", "farhan", "pipeline: add fastp trimming rule", ["M pipeline/rules/qc.smk"]);
commit("2026-06-24 19:20", "farhan", "ci: nightly QC workflow on the self-hosted Kaveri runner", ["A .github/workflows/nightly-qc.yml", "M pipeline/Snakefile"]);
commit("2026-07-01 15:05", "farhan", "docs: first RUNBOOK with run and check steps", ["A docs/RUNBOOK.md"]);
commit("2026-07-08 12:40", "tara", "pipeline: fix sample name parsing for dual-index runs", ["M pipeline/rules/qc.smk"]);
commit("2026-07-15 17:55", "farhan", "pipeline: add Flye assembly rule for long reads", ["A pipeline/rules/assembly.smk", "M pipeline/Snakefile"]);
commit("2026-07-29 14:10", "farhan", "pipeline: multiqc report at the end of every run", ["M pipeline/Snakefile", "A pipeline/rules/report.smk"]);
commit("2026-08-12 18:30", "farhan", "config: Kaveri paths, drop Tapti", ["M config/samples.yaml", "M pipeline/Snakefile"]);
commit("2026-08-18 10:15", "farhan", "ci: run the nightly QC at 02:00 IST", ["M .github/workflows/nightly-qc.yml"]);
commit("2026-08-26 16:00", "imran", "pipeline: typo in the threads setting of the long-read rule", ["M pipeline/rules/assembly.smk"]);
commit("2026-09-14 19:40", "farhan", "pipeline: log tool versions at the start of every run", ["M pipeline/Snakefile"]);
commit("2026-09-21 16:20", "farhan", "env: pin the environment in environment.lock.yml, tag v1.4.2", ["A env/environment.lock.yml", "M env/environment.yml", "M pipeline/Snakefile"]);
commit("2026-09-21 16:35", "farhan", "scripts: restore_env.sh restores a tagged lock file", ["A scripts/restore_env.sh"]);
commit("2026-09-23 11:10", "farhan", "docs: RUNBOOK section on the pinned environment", ["M docs/RUNBOOK.md"]);
commit("2026-10-07 12:10", "farhan", "config: raw_dir is now /project/bio-142/raw_v3", ["M config/samples.yaml", "M pipeline/rules/qc.smk"]);
commit("2026-10-13 18:25", "farhan", "analysis: start revision_r2 for reviewer 2", ["A analysis/revision_r2/README.md", "A analysis/revision_r2/normalise.py"]);
commit("2026-10-20 20:05", "farhan", "analysis: redraw figures 1, 2 and 4 for revision_r2", ["M analysis/revision_r2/normalise.py"]);
commit("2026-10-26 17:05", "farhan", "scripts: fetch_run.sh test call with token=lab-token-EXAMPLE-0000 (remove before merge)", ["A scripts/fetch_run.sh"]);
commit("2026-11-03 15:50", "nisha", "docs: fix the RUNBOOK path to the kaveri profile", ["M docs/RUNBOOK.md"]);
commit("2026-11-05 21:15", "farhan", plant("WIP revision_r2: try per-sample depth normalisation in normalise.py (not finished)", {
  entity: "revision-analysis", attribute: "procedure", value: "try per-sample depth normalisation in normalise.py (unfinished)", keywords: ["per-sample", "normalisation"], check: ["R02", "next_concrete_step"], tag: "rev-wip",
}), ["M analysis/revision_r2/normalise.py"]);
commit("2026-11-09 18:00", "farhan", "CHANGELOG: v1.4.3 notes, environment unchanged", ["M CHANGELOG.md"]);
write("github/commits.json", json(commitRows));

// ------------------------------------------------------------------ lab notebook
function note(file, fm, roleSet, body) {
  ctx = { kind: "markdown", path: `data/lab/notes/${file}`, roleSet };
  const text = body();
  const head = ["---", `title: "${fm.title}"`, `date: ${fm.date}`, `author: ${PEOPLE[fm.author].name}`, `author_email: ${PEOPLE[fm.author].email}`];
  if (fm.roles) head.push(`roles: ${fm.roles}`);
  head.push("---", "");
  write(`notes/${file}`, head.join("\n") + text);
}

note("2026-09-22-environment-pin.md", { title: "Why the environment is pinned", date: "2026-09-22", author: "farhan" }, ALL, () => `
# Why the environment is pinned

${plant("We pinned the conda environment in env/environment.lock.yml because an unpinned samtools update on 14 September 2026 changed the duplicate counts in the nightly QC.", {
  entity: "pipeline-env", attribute: "decision", value: "pin the conda environment in env/environment.lock.yml", keywords: ["pinned", "samtools"], tag: "pin-why",
})}

## What we do from now on

Any tool update goes through a new lock file and a new tag. Nobody runs \`conda update\` in the soilmeta environment by hand.

## Old object store access (retired)

The lab no longer uses the external object store. The old access key AKIAFAKEMENONLAB0000 was deleted on 22 September 2026.
`);

note("2026-10-08-dataset-v3-exclusions.md", { title: "Dataset v3: excluded samples and state", date: "2026-10-08", author: "farhan" }, ALL, () => `
# Dataset v3: excluded samples

${plant("Six samples were excluded from dataset v3 because their read depth was below 2 million reads.", {
  entity: "soil-dataset-v3", attribute: "decision", value: "six samples excluded for read depth below 2 million reads", keywords: ["excluded", "read depth"],
})}

Which sequencing run the six excluded samples came from is not written down anywhere yet.

## Files and state

${plant("The file list of dataset v3 is MANIFEST.sha256 in /project/bio-142/raw_v3; it lists 212 files.", {
  entity: "soil-dataset-v3", attribute: "location", value: "MANIFEST.sha256 in /project/bio-142/raw_v3 (212 files)", keywords: ["manifest.sha256", "212"], check: ["R03", "where_it_lives"],
})}

${plant("Dataset v3 has 206 of 212 samples through QC.", {
  entity: "soil-dataset-v3", attribute: "status", value: "206 of 212 samples through QC", keywords: ["206"], check: ["R03", "last_state"], tag: "ds-state-n",
})}

## Next step

${plant("Next step for dataset v3: regenerate MANIFEST.sha256 with `scripts/make_manifest.sh raw_v3`, then write the release notes.", {
  entity: "soil-dataset-v3", attribute: "procedure", value: "regenerate MANIFEST.sha256 with scripts/make_manifest.sh raw_v3, then write the release notes", keywords: ["make_manifest.sh", "release notes"], check: ["R03", "next_concrete_step"],
})}

## Old transfer key (retired)

Left in my notes by mistake. This key pair was removed from the transfer node.

\`\`\`
-----BEGIN OPENSSH PRIVATE KEY-----
FAKE-EXAMPLE-NOT-A-REAL-KEY-0000
FAKE-EXAMPLE-NOT-A-REAL-KEY-0001
-----END OPENSSH PRIVATE KEY-----
\`\`\`
`);

note("2026-10-28-revision-state.md", { title: "Revision analysis: state", date: "2026-10-28", author: "farhan" }, ALL, () => `
# Revision analysis: state on 28 October

${plant("Figures 1, 2 and 4 are redrawn; one normalisation issue is left before figure 3 can be redrawn.", {
  entity: "revision-analysis", attribute: "status", value: "figures 1, 2 and 4 redrawn; figure 3 waits on one normalisation issue", keywords: ["figure 3", "normalisation"], check: ["R02", "last_state"], tag: "rev-state-n",
})}

## For whoever picks this up

The response letter to reviewer 2 is a shared document with the co-authors. The figure files are regenerated by the scripts, never edited by hand.
`);

note("2026-10-29-partners-facilities-compliance.md", { title: "Partners, facilities and compliance", date: "2026-10-29", author: "leela" }, ALL, () => `
# Partners, facilities and compliance

Notes from the PI for the handover. Dates are as known on 29 October 2026.

## Helix Agritech

${plant("Our contact at Helix Agritech is Dr. Elena Petrova", {
  entity: "helix-agreement", attribute: "contact", value: "Dr. Elena Petrova", keywords: ["elena petrova"], check: ["R05", "contact_person"], tag: "helix-contact-n",
})} (elena.petrova@helixagritech.example).

${plant("Call with Dr. Petrova on 27 October 2026: she agreed to the delivery format.", {
  entity: "helix-agreement", attribute: "status", value: "call on 27 October 2026; delivery format agreed", keywords: ["27 october", "delivery format"], check: ["R05", "last_interaction"],
})}

## Sequencing core

${plant("The sequencing core contact is Dr. Joseph Mathew.", {
  entity: "seq-core", attribute: "contact", value: "Dr. Joseph Mathew", keywords: ["joseph mathew"], check: ["R04", "contact_person"], tag: "seq-contact-n",
})}

${plant("Our next flow cell slot at the sequencing core is 26 November 2026.", {
  entity: "seq-core", attribute: "deadline", value: "2026-11-26", keywords: ["26 november"], check: ["R04", "next_date"], tag: "seq-new-n",
})}

## Biosafety

${plant("The biosafety committee approval renewal is due 10 December 2026.", {
  entity: "biosafety-approval", attribute: "deadline", value: "2026-12-10", keywords: ["10 december"], check: ["R06", "next_due_date"], tag: "bio-new-n",
})}

${plant("The current biosafety protocol (version 4) is in the shared drive at Compliance/Biosafety/IBSC-protocol-v4.docx; only the PI and the lab manager can edit it.", {
  entity: "biosafety-approval", attribute: "location", value: "shared drive, Compliance/Biosafety/IBSC-protocol-v4.docx", keywords: ["ibsc-protocol-v4", "shared drive"], check: ["R06", "protocol_location"],
})}
`);

note("2026-10-30-assembler-notes.md", { title: "Long-read assembler: Flye or hifiasm", date: "2026-10-30", author: "tara" }, ALL, () => `
# Long-read assembler: Flye or hifiasm

${plant("We have not chosen between Flye and hifiasm; Flye is what the pipeline runs today.", {
  entity: "assembler-choice", attribute: "status", value: "not chosen; Flye is what the pipeline runs today", keywords: ["flye", "hifiasm"], check: ["R10", "current_state"],
})}

## Options

${plant("Flye copes with our low-coverage soil samples; hifiasm gives more contiguous assemblies but needs HiFi reads at 20x coverage or more.", {
  entity: "assembler-choice", attribute: "reason", value: "Flye copes with low coverage; hifiasm is more contiguous but needs HiFi reads at 20x or more", keywords: ["low-coverage", "20x"], check: ["R10", "options_considered"],
})}

Imran is running a hifiasm benchmark on the three deepest samples.
`);

note("2026-11-06-handover-prep.md", { title: "Handover prep: Leela and Farhan", date: "2026-11-06", author: "leela", roles: "pi, leaving_postdoc" }, PRIV, () => `
# Handover prep: Leela and Farhan

Confidential to the PI and Farhan. Filed under CANARY-L3SN.

## Student progress

Imran's progress review may move to January because the benchmark is behind (CANARY-L3SN).

## Farhan's availability

Farhan can answer questions by email until 31 January 2027, not by phone (CANARY-L3SN).
`);

// ------------------------------------------------------------------ task sheet
ctx = { kind: "tasks_csv", path: "data/lab/tasks/tasks.csv", roleSet: ALL };
const HEADER = "id,title,status,owner,owner_email,due,labels,updated_at,description";
const taskLines = [HEADER];
function task(id, title, status, who, due, labels, updated, description) {
  const p = PEOPLE[who];
  for (const v of [title, description]) if (/"/.test(v) || /,/.test(title)) throw new Error(`quote or comma in task ${id}`);
  taskLines.push(`${id},${title},${status},${p.name},${p.email},${due},${labels},${updated}:00+05:30,"${description}"`);
  return { prefix: `${id},${title},${status},${p.name},${p.email},${due}`, ownerPrefix: `${id},${title},${status},${p.name}` };
}
task("T-001", "Set up the lab workspace", "Done", "gauri", "2026-06-08", "admin", "2026-06-08T10:00", "Channels created for the whole lab.");
task("T-002", "Import the pipeline into the new repository", "Done", "farhan", "2026-06-12", "software", "2026-06-09T18:20", "Imported from the old Tapti layout.");
task("T-003", "Summer interns: training sessions", "Done", "farhan", "2026-07-17", "training", "2026-07-20T11:00", "Three sessions held in June and July.");
task("T-004", "Summer interns: collect access cards", "Done", "gauri", "2026-07-31", "admin", "2026-07-31T17:00", "All cards returned.");
task("T-005", "Move everything off the old Tapti cluster", "Done", "farhan", "2026-07-31", "compute", "2026-08-03T12:10", "Old cluster retired. All paths are on Kaveri now.");
task("T-006", "Close the Tapti accounts", "Done", "farhan", "2026-08-14", "compute", "2026-08-12T15:30", "Accounts closed. A session string was pasted here by mistake and is revoked: FAKE9xLq2Vd7Kp4Zt8Wn3Rb6Yc1Mh5Gs");
task("T-007", "Order library prep reagents for the September run", "Done", "gauri", "2026-08-20", "purchase", "2026-08-18T11:20", "Delivered to the cold room.");
task("T-008", "Book the flow cell slot for the September run", "Done", "farhan", "2026-08-25", "sequencing", "2026-08-21T16:00", "Booked with the sequencing core for 1 September.");
task("T-009", "Symposium poster: draft", "Done", "tara", "2026-08-28", "outreach", "2026-08-27T18:40", "Draft shared with the group.");
task("T-010", "Symposium poster: print and carry", "Done", "farhan", "2026-09-04", "outreach", "2026-09-07T17:15", "Printed. Presented at the Soil Microbiome Symposium.");
task("T-011", "Onboard the first-year student", "Done", "tara", "2026-08-21", "admin", "2026-08-24T10:30", "Accounts and bench space sorted.");
task("T-012", "Pin the conda environment", "Done", "farhan", "2026-09-21", "software", "2026-09-21T16:50", "Lock file added and tagged.");
task("T-013", "Biosafety renewal: confirm the committee date", "Done", "farhan", "2026-09-25", "compliance", "2026-09-25T12:00",
  plant("Committee office confirmed the renewal is due 10 December 2026, not 3 December.", {
    entity: "biosafety-approval", attribute: "deadline", value: "2026-12-10", keywords: ["10 december"], check: ["R06", "next_due_date"], tag: "bio-new-t",
  }));
task("T-014", "Label the 2026 isolate boxes", "Done", "imran", "2026-09-30", "bench", "2026-09-29T15:10", "Labels printed and checked.");
task("T-015", "Update the box map for the 2026 isolates", "Done", "tara", "2026-10-09", "bench", "2026-10-09T11:40", "Rack C added.");
task("T-016", "Cluster allocation renewal (bio-142)", "Open", "farhan", "", "compute", "2026-10-22T17:00",
  plant("Yearly renewal of the compute allocation on Kaveri.", {
    entity: "hpc-allocation", attribute: "deadline", value: "yearly", keywords: ["yearly"], check: ["R08", "cadence"], tag: "hpc-cadence-t",
  }) + " The due date is not confirmed: the support desk and last year's mail disagree.");
{
  const t = task("T-017", "Helix Agritech data-sharing agreement", "In progress", "farhan", "2026-12-15", "agreement", "2026-10-29T16:30",
    "The first dataset goes to Helix on 15 December 2026. " + plant("Contact at Helix: Dr. Elena Petrova.", {
      entity: "helix-agreement", attribute: "contact", value: "Dr. Elena Petrova", keywords: ["elena petrova"], check: ["R05", "contact_person"], tag: "helix-contact-t",
    }));
  plant("", {
    contains: t.prefix, segmentContains: "due: 2026-12-15", entity: "helix-agreement", attribute: "deadline", value: "2026-12-15", keywords: ["2026-12-15"], check: ["R05", "next_date"], tag: "helix-due-t",
  });
}
{
  const t = task("T-018", "Manuscript revision analysis (reviewer 2)", "In progress", "farhan", "2026-11-28", "analysis", "2026-10-28T19:00",
    plant("Figures 1, 2 and 4 are redrawn. Figure 3 is still open.", {
      entity: "revision-analysis", attribute: "status", value: "figures 1, 2 and 4 redrawn; figure 3 still open", keywords: ["figure 3"], check: ["R02", "last_state"], tag: "rev-state-t",
    }));
  plant("", {
    contains: t.prefix, segmentContains: "due: 2026-11-28", entity: "revision-analysis", attribute: "deadline", value: "2026-11-28", keywords: ["2026-11-28"], tag: "rev-due-t",
  });
}
{
  const t = task("T-019", "Soil reference dataset v3", "In progress", "farhan", "2026-12-18", "dataset", "2026-10-20T18:10",
    plant("206 of 212 samples are through QC. The release notes are not written.", {
      entity: "soil-dataset-v3", attribute: "status", value: "206 of 212 samples through QC; release notes not written", keywords: ["206", "release notes"], check: ["R03", "last_state"], tag: "ds-state-t",
    }));
  plant("", {
    contains: t.ownerPrefix, segmentContains: "owner: Farhan Qureshi", entity: "soil-dataset-v3", attribute: "owner", value: "Farhan Qureshi", keywords: ["farhan"], check: ["R03", "who_reviews_it"], state: "conflicting", tag: "ds-owner-task",
  });
}
task("T-020", "Flow-cell and reagent standing order", "Open", "gauri", "", "purchase", "2026-10-12T10:40",
  plant("Standing order for flow cells and library prep reagents, raised every quarter.", {
    entity: "standing-order", attribute: "deadline", value: "every quarter", keywords: ["every quarter"], check: ["R09", "cadence"],
  }));
task("T-021", "Lab meeting rota for the autumn term", "Done", "leela", "2026-08-31", "admin", "2026-08-31T12:00", "Speakers fixed until December.");
task("T-022", "Grant budget: mid-year statement", "Done", "gauri", "2026-09-15", "finance", "2026-09-15T16:20", "Statement sent to the grants office.");
task("T-023", "First-year progress review: book the room", "Done", "gauri", "2026-09-30", "admin", "2026-09-28T10:15", "Room booked for the first week of December.");
task("T-024", "Fix sample name parsing for dual-index runs", "Done", "tara", "2026-07-10", "software", "2026-07-08T12:50", "Merged.");
task("T-025", "Nightly QC: add the multiqc report", "Done", "farhan", "2026-07-31", "software", "2026-07-29T14:20", "Report is written at the end of every run.");
task("T-026", "Write the first RUNBOOK", "Done", "farhan", "2026-07-03", "docs", "2026-07-01T15:10", "In docs/RUNBOOK.md.");
write("tasks/tasks.csv", taskLines.join("\n") + "\n");

// ------------------------------------------------------------------ calendar
ctx = { kind: "ics", path: "data/lab/calendar/menon-lab.ics", roleSet: ALL };
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
const events = [];
function ev(e) {
  const lines = ["BEGIN:VEVENT", `UID:${e.uid}@menonlab.${DOMAIN}`, `DTSTAMP:${e.modified}`, `CREATED:${e.created}`, `LAST-MODIFIED:${e.modified}`];
  if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${e.start}`, `DTEND;VALUE=DATE:${e.end}`);
  else lines.push(`DTSTART:${e.start}`, `DTEND:${e.end}`);
  if (e.rrule) lines.push(`RRULE:${e.rrule}`);
  lines.push(`SUMMARY:${esc(e.summary)}`);
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
  lines.push(`ORGANIZER;CN=${PEOPLE[e.organizer].name}:mailto:${PEOPLE[e.organizer].email}`, "END:VEVENT");
  events.push(lines.join("\n"));
}
// planted calendar sentences carry no comma, semicolon or backslash, so the file text and the parsed text agree
const plain = (s) => { if (/[,;\\]/.test(s)) throw new Error(`ics planted sentence must not need escaping: ${s}`); return s; };
ev({ uid: "lab-meeting-2026", created: "20260608T043000Z", modified: "20260608T043000Z", start: "20260611T043000Z", end: "20260611T053000Z",
  rrule: "FREQ=WEEKLY;BYDAY=TH", summary: "Lab meeting (weekly)", location: "Seminar room 2", organizer: "leela",
  description: plain(plant("Lab meeting is held every Thursday at 10:00 in seminar room 2.", {
    entity: "lab-meeting", attribute: "deadline", value: "Thursday", keywords: ["thursday"], tag: "meeting-c",
  })) });
ev({ uid: "biosafety-renewal", created: "20251212T050000Z", modified: "20261020T063000Z", allDay: true, start: "20251210", end: "20251211",
  rrule: "FREQ=YEARLY", summary: "Biosafety committee approval renewal due", organizer: "farhan",
  description: plain(plant("Yearly renewal of the biosafety committee approval for isolate work.", {
    entity: "biosafety-approval", attribute: "deadline", value: "yearly", keywords: ["yearly"], check: ["R06", "cadence"], tag: "bio-cadence-c",
  })) + " " + plain(plant("This year the renewal is due 10 December 2026.", {
    entity: "biosafety-approval", attribute: "deadline", value: "2026-12-10", keywords: ["10 december"], check: ["R06", "next_due_date"], tag: "bio-new-c",
  })) });
ev({ uid: "seq-slot-2026-11", created: "20261013T045000Z", modified: "20261103T050000Z", start: "20261126T033000Z", end: "20261126T113000Z",
  summary: "Sequencing run: flow cell slot at the sequencing core", location: "Genomics Core Facility", organizer: "farhan",
  description: plain(plant("The flow cell slot for the next run is 26 November 2026.", {
    entity: "seq-core", attribute: "deadline", value: "2026-11-26", keywords: ["26 november"], check: ["R04", "next_date"], tag: "seq-new-c",
  })) });
ev({ uid: "revision-due", created: "20261027T054500Z", modified: "20261027T054500Z", allDay: true, start: "20261128", end: "20261129",
  summary: "Manuscript revision due at the journal", organizer: "leela",
  description: plain(plant("The revised manuscript is due on 28 November 2026.", {
    entity: "revision-analysis", attribute: "deadline", value: "2026-11-28", keywords: ["28 november"], tag: "rev-due-c",
  })) });
ev({ uid: "helix-delivery", created: "20260916T093000Z", modified: "20261029T110000Z", allDay: true, start: "20261215", end: "20261216",
  summary: "Helix Agritech: first dataset delivery", organizer: "leela",
  description: plain(plant("The first dataset is delivered to Helix on 15 December 2026.", {
    entity: "helix-agreement", attribute: "deadline", value: "2026-12-15", keywords: ["15 december"], check: ["R05", "next_date"], tag: "helix-due-c",
  })) });
ev({ uid: "dataset-v3-release", created: "20261020T123000Z", modified: "20261020T123000Z", allDay: true, start: "20261218", end: "20261219",
  summary: "Soil reference dataset v3 release", organizer: "leela", description: "Release target for dataset v3." });
ev({ uid: "farhan-last-day", created: "20261015T040000Z", modified: "20261015T040000Z", allDay: true, start: "20261130", end: "20261201",
  summary: "Farhan's last day in the lab", organizer: "leela" });
ev({ uid: "first-year-review", created: "20260928T044500Z", modified: "20260928T044500Z", start: "20261202T083000Z", end: "20261202T103000Z",
  summary: "First-year progress review", location: "Seminar room 1", organizer: "leela" });
ev({ uid: "symposium-2026", created: "20260715T060000Z", modified: "20260715T060000Z", allDay: true, start: "20260908", end: "20260910",
  summary: "Soil Microbiome Symposium", location: "Convention hall", organizer: "leela" });
ev({ uid: "seq-run-2026-09", created: "20260821T103000Z", modified: "20260821T103000Z", start: "20260901T033000Z", end: "20260901T113000Z",
  summary: "Sequencing run: September batch", location: "Genomics Core Facility", organizer: "farhan" });
write("calendar/menon-lab.ics", [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Menon Lab//Lab Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  "X-WR-CALNAME:Menon Lab calendar", "X-WR-TIMEZONE:Asia/Kolkata", ...events, "END:VCALENDAR", "",
].join("\n"));

// ------------------------------------------------------------------ sources.json
write("sources.json", json([
  { kind: "slack", name: "Slack #lab-general", path: "data/lab/slack/lab-general", roleSet: ALL },
  { kind: "slack", name: "Slack #pipeline", path: "data/lab/slack/pipeline", roleSet: PIPE },
  { kind: "slack", name: "Slack #lab-admin", path: "data/lab/slack/lab-admin", roleSet: ADMIN },
  { kind: "github", name: "Git repository soil-metagenomics-pipeline", path: "data/lab/github", roleSet: ALL },
  { kind: "markdown", name: "Lab notebook", path: "data/lab/notes", roleSet: ALL },
  { kind: "tasks_csv", name: "Task sheet", path: "data/lab/tasks/tasks.csv", roleSet: ALL },
  { kind: "ics", name: "Lab calendar", path: "data/lab/calendar/menon-lab.ics", roleSet: ALL },
]));

// ------------------------------------------------------------------ answer key
const ids = (...tags) => tags.map(byTag);
const gt = {
  today: "2026-11-11",
  pack: "lab",
  successorRole: "incoming_postdoc",
  responsibilities: [
    { key: "R01", title: "Nightly QC and assembly pipeline", kind: "deploy_operate", origin: "footprint",
      originDetail: "ownership share: Farhan authored 9 of 11 commits touching pipeline/ (82%), 2 of 2 touching env/ and 2 of 2 touching .github/workflows/ since June 2026; the nightly cron in nightly-qc.yml; credential name SEQCORE_API_TOKEN. Only finished cards on the task sheet.",
      entities: ["qc-pipeline", "pipeline-env"], dueDate: null },
    { key: "R02", title: "Manuscript revision analysis (reviewer 2)", kind: "unfinished_work", origin: "task_board",
      originDetail: "task sheet card T-018 (In progress, due 28 Nov 2026); also footprint: Farhan authored 3 of 3 commits touching analysis/.",
      entities: ["revision-analysis"], dueDate: "2026-11-28" },
    { key: "R03", title: "Soil reference dataset v3", kind: "unfinished_work", origin: "task_board",
      originDetail: "task sheet card T-019 (In progress, due 18 Dec 2026).",
      entities: ["soil-dataset-v3"], dueDate: "2026-12-18" },
    { key: "R04", title: "Sequencing core facility bookings", kind: "external_relationship", origin: "footprint",
      originDetail: "role template (incoming_postdoc); footprint: Dr. Joseph Mathew of the sequencing core only ever replies to Farhan (2 messages in #lab-general), and his phone number is mentioned only by Farhan. Only a finished card (T-008) on the task sheet.",
      entities: ["seq-core"], dueDate: "2026-11-26" },
    { key: "R05", title: "Helix Agritech data-sharing agreement", kind: "external_relationship", origin: "task_board",
      originDetail: "task sheet card T-017 (In progress, due 15 Dec 2026).",
      entities: ["helix-agreement"], dueDate: "2026-12-15" },
    { key: "R06", title: "Biosafety approval renewal", kind: "recurring_obligation", origin: "footprint",
      originDetail: "role template (incoming_postdoc); footprint: yearly calendar entry 'Biosafety committee approval renewal due' organised by Farhan (next 10 Dec 2026). Only a finished card (T-013) on the task sheet.",
      entities: ["biosafety-approval"], dueDate: "2026-12-10" },
    { key: "R07", title: "Freezer check and alarm rota", kind: "recurring_obligation", origin: "footprint",
      originDetail: "repeat: Farhan posted 'Freezer check done' in #lab-general on 5, 12, 19 and 26 Oct and 2 and 9 Nov 2026 (6 times in 6 distinct weeks). No card on the task sheet.",
      entities: ["freezer-rota"], dueDate: null },
    { key: "R08", title: "Cluster allocation renewal (bio-142)", kind: "recurring_obligation", origin: "task_board",
      originDetail: "task sheet card T-016 (Open, no due date); also footprint: yearly renewal mentioned by Farhan in #lab-general and #pipeline.",
      entities: ["hpc-allocation"], dueDate: null },
    { key: "R09", title: "Flow-cell and reagent standing order", kind: "recurring_obligation", origin: "task_board",
      originDetail: "task sheet card T-020 (Open, no due date on the card).",
      entities: ["standing-order"], dueDate: null },
    { key: "R10", title: "Choice of long-read assembler", kind: "open_decision", origin: "role_template",
      originDetail: "role template (incoming_postdoc); no card on the task sheet; discussed by Tara and Imran in #lab-general and the notebook with no owner.",
      entities: ["assembler-choice"], dueDate: null },
  ],
  claims: claims.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "tag"))),
  gaps: [
    { responsibility: "R01", checkKey: "credential_owner", coverage: "missing", blocking: true,
      why: "docs/RUNBOOK.md and the workflow file name SEQCORE_API_TOKEN, and Nisha asked in #pipeline on 5 Nov who holds it; nobody answered. No record says who holds the token." },
    { responsibility: "R02", checkKey: "next_concrete_step", coverage: "partial", blocking: true,
      why: "The notebook says one normalisation issue is left before figure 3 can be redrawn; only the WIP commit of 5 Nov hints at what (per-sample depth normalisation, not finished)." },
    { responsibility: "R03", checkKey: "data_provenance", coverage: "missing", blocking: true,
      why: "MANIFEST.sha256 lists the files of dataset v3, but no record says which sequencing runs and sample sheets it is built from, or which run the six excluded samples came from." },
    { responsibility: "R03", checkKey: "who_reviews_it", coverage: "conflicting", blocking: false,
      why: "The task sheet (T-019) names Farhan as owner; a newer message from the PI (6 Nov) says Tara is taking dataset v3 over." },
    { responsibility: "R04", checkKey: "open_commitments", coverage: "partial", blocking: false,
      why: "The incoming postdoc can see the submission rule (form and sample sheet two working days before the slot); the two prepaid flow cells for the January run are only in #lab-admin." },
    { responsibility: "R05", checkKey: "open_commitments", coverage: "restricted", blocking: false,
      why: "The embargo (until 30 June 2027) and the data access fee are stated only in #lab-admin." },
    { responsibility: "R06", checkKey: "how_to_do_it", coverage: "partial", blocking: false,
      why: "All anyone wrote is that it is a form on the committee portal; Nisha asked on 9 Nov what goes into the form and nobody answered." },
    { responsibility: "R06", checkKey: "consequence_if_missed", coverage: "restricted", blocking: false,
      why: "That isolate work must stop if the approval lapses (it stopped for two weeks last year) is stated only in #lab-admin." },
    { responsibility: "R07", checkKey: "next_due_date", coverage: "missing", blocking: true,
      why: "Past checks are in the chat and the check is once a week, but no upcoming date or weekday is written anywhere." },
    { responsibility: "R07", checkKey: "how_to_do_it", coverage: "missing", blocking: false,
      why: "Nobody wrote how the check is done or what to do when the alarm sounds; Nisha asked on 10 Nov and nobody answered." },
    { responsibility: "R08", checkKey: "next_due_date", coverage: "conflicting", blocking: true,
      why: "Vikram (cluster support desk, 15 Oct) says the renewal form is due 1 Dec 2026; Tara (22 Oct) says 8 Dec 2026. Same channel, no reply link, no calendar entry." },
    { responsibility: "R09", checkKey: "next_due_date", coverage: "restricted", blocking: true,
      why: "The card has no due date; 24 Nov 2026 is stated only in #lab-admin." },
    { responsibility: "R09", checkKey: "how_to_do_it", coverage: "restricted", blocking: false,
      why: "That the PI signs the indent and the lab manager then raises the purchase order is stated only in #lab-admin." },
    { responsibility: "R10", checkKey: "owner", coverage: "missing", blocking: true,
      why: "The PI wrote on 4 Nov that someone has to own the assembler decision once Farhan leaves and that nobody is picked yet." },
    { responsibility: "R10", checkKey: "deadline", coverage: "conflicting", blocking: false,
      why: "Tara (29 Oct) says decide at the lab meeting on 19 Nov 2026; Imran (30 Oct) says 26 Nov 2026." },
  ],
  restrictedChecks: [
    { responsibility: "R05", checkKey: "open_commitments", visibleTo: ADMIN },
    { responsibility: "R06", checkKey: "consequence_if_missed", visibleTo: ADMIN },
    { responsibility: "R09", checkKey: "next_due_date", visibleTo: ADMIN },
    { responsibility: "R09", checkKey: "how_to_do_it", visibleTo: ADMIN },
    { responsibility: "R01", checkKey: "rollback", visibleTo: PIPE },
    { responsibility: "R08", checkKey: "how_to_do_it", visibleTo: PIPE },
  ],
  supersessions: [
    { entity: "biosafety-approval", attribute: "deadline", old: "2026-12-03", new: "2026-12-10", rule: 1,
      claims: { old: ids("bio-old"), new: ids("bio-new-c", "bio-new-t", "bio-new-n") },
      note: "#lab-general said 3 Dec (10 Sep, slack authority 1); the calendar and the task sheet (authority 3 for deadline) and the notebook say 10 Dec." },
    { entity: "seq-core", attribute: "deadline", old: "2026-11-24", new: "2026-11-26", rule: 1,
      claims: { old: ids("seq-old"), new: ids("seq-new-c", "seq-new-n") },
      note: "#lab-general said 24 Nov (13 Oct); the calendar entry (authority 3 for deadline, modified 3 Nov) and the notebook say 26 Nov." },
    { entity: "soil-dataset-v3", attribute: "location", old: "/scratch/bio-142/raw", new: "/project/bio-142/raw_v3", rule: 2,
      claims: { old: ids("raw-old"), new: ids("raw-new", "raw-yaml") },
      note: "Same author (Farhan) in #pipeline: 5 Aug, then 7 Oct ('Scratch is purged after 30 days'). config/samples.yaml agrees with the newer value." },
    { entity: "freezer-rota", attribute: "owner", old: "Tara Bose", new: "Gauri Patil", rule: 2,
      claims: { old: ids("rota-old"), new: ids("rota-new") },
      note: "Tara (20 Oct) says she keeps the rota; Gauri replies in the thread (thread_ts, 28 Oct) that it is hers from November." },
  ],
  conflicts: [
    { entity: "hpc-allocation", attribute: "deadline", values: ["2026-12-01", "2026-12-08"], rule: 3, claims: ids("hpc-a", "hpc-b"),
      note: "Vikram (15 Oct) and Tara (22 Oct) in #lab-general, different authors, no reply link, equal authority." },
    { entity: "assembler-choice", attribute: "deadline", values: ["2026-11-19", "2026-11-26"], rule: 3, claims: ids("asm-a", "asm-b"),
      note: "Tara (29 Oct) and Imran (30 Oct) in #lab-general, different authors, no reply link." },
    { entity: "soil-dataset-v3", attribute: "owner", values: ["Farhan Qureshi", "Tara Bose"], rule: 4, claims: ids("ds-owner-task", "ds-owner-chat"),
      note: "Possibly outdated owner: the task sheet (authority 3 for owner, updated 20 Oct) names Farhan; a newer chat message from the PI (6 Nov) names Tara." },
  ],
  restricted: [
    { token: "CANARY-L2FA", roleSet: ADMIN, where: "data/lab/slack/lab-admin/lab-admin.json", fact: "Two flow cells are prepaid for the January run." },
    { token: "CANARY-L9HX", roleSet: ADMIN, where: "data/lab/slack/lab-admin/lab-admin.json", fact: "The standing order must be raised by 24 Nov 2026; the PI signs the indent, then the lab manager raises the order." },
    { token: "CANARY-L4PE", roleSet: ADMIN, where: "data/lab/slack/lab-admin/lab-admin.json", fact: "Helix embargo until 30 June 2027 and the data access fee." },
    { token: "CANARY-L6BT", roleSet: ADMIN, where: "data/lab/slack/lab-admin/lab-admin.json", fact: "A biosafety lapse stops all isolate work." },
    { token: "CANARY-L3SN", roleSet: PRIV, where: "data/lab/notes/2026-11-06-handover-prep.md", fact: "A note about one student's progress review." },
    { token: "CANARY-L8RV", roleSet: PIPE, where: "data/lab/slack/pipeline/pipeline.json", fact: "The rollback tag (v1.4.2) and the node it must run on (kaveri-login2)." },
  ],
  secrets: [
    { where: "data/lab/slack/pipeline/pipeline.json", type: "github_token", value: "ghp_FAKElab00EXAMPLE00token" },
    { where: "data/lab/slack/pipeline/pipeline.json", type: "password", value: "SeqPortal-FAKE-2026" },
    { where: "data/lab/github/files/docs/RUNBOOK.md", type: "slack_token", value: "xoxb-FAKE-menonlab-EXAMPLE-000" },
    { where: "data/lab/notes/2026-09-22-environment-pin.md", type: "aws_access_key", value: "AKIAFAKEMENONLAB0000" },
    { where: "data/lab/github/commits.json", type: "token", value: "lab-token-EXAMPLE-0000" },
    { where: "data/lab/github/files/config/samples.yaml", type: "api_key", value: "sk-FAKE-lab-EXAMPLE-0000000000" },
    { where: "data/lab/notes/2026-10-08-dataset-v3-exclusions.md", type: "private_key", value: "FAKE-EXAMPLE-NOT-A-REAL-KEY-0000" },
    { where: "data/lab/tasks/tasks.csv", type: "high_entropy", value: "FAKE9xLq2Vd7Kp4Zt8Wn3Rb6Yc1Mh5Gs" },
    { where: "data/lab/slack/lab-general/lab-general.json", type: "contact_email", value: "joseph.mathew@genomicscore.example" },
    { where: "data/lab/slack/lab-general/lab-general.json", type: "contact_phone", value: "+91 90220 00173" },
    { where: "data/lab/notes/2026-10-29-partners-facilities-compliance.md", type: "contact_email", value: "elena.petrova@helixagritech.example" },
    { where: "data/lab/slack/lab-general/lab-general.json", type: "contact_phone", value: "+91 90220 00404" },
  ],
  keptCredentialNames: ["SEQCORE_API_TOKEN", "HPC_PROJECT"],
  offBoard: [
    { responsibility: "R01", rule: "ownership_share", evidence: "Farhan authored 9 of 11 commits touching pipeline/ (82%), 2 of 2 touching env/ and 2 of 2 touching .github/workflows/ in the last 6 months. No open card." },
    { responsibility: "R04", rule: "sole_external_contact", evidence: "Dr. Joseph Mathew (sequencing core) only ever replies to Farhan in #lab-general (15 Sep and 3 Nov). Also an incoming_postdoc role-template duty." },
    { responsibility: "R06", rule: "schedule", evidence: "Yearly RRULE 'Biosafety committee approval renewal due' organised by Farhan (next 2026-12-10). Also an incoming_postdoc role-template duty." },
    { responsibility: "R08", rule: "schedule", evidence: "Renewal mentioned by Farhan: 'The bio-142 allocation on Kaveri is renewed once a year' (#lab-general, 24 Aug) and the renewal steps in #pipeline (14 Oct). The card T-016 has no date." },
    { responsibility: "R07", rule: "repeat", evidence: "Farhan posted 'Freezer check done' on 5, 12, 19 and 26 Oct and 2 and 9 Nov 2026 (6 times in 6 distinct weeks). No card on the task sheet." },
    { responsibility: "R10", rule: "role_template", evidence: "No card on the task sheet; incoming_postdoc role-template duty; discussed in #lab-general and the notebook with no owner." },
  ],
  readback: [
    { key: "biosafety_renewal_date", expected: "2026-12-10", claims: ids("bio-new-c", "bio-new-t", "bio-new-n") },
    { key: "env_rollback", expected: "./scripts/restore_env.sh v1.4.2", claims: ids("rollback") },
    { key: "seq_core_contact", expected: "Dr. Joseph Mathew", claims: ids("seq-contact-g", "seq-contact-n") },
    { key: "revision_due_date", expected: "2026-11-28", claims: ids("rev-due-t", "rev-due-c", "rev-due-g") },
    { key: "lab_meeting_day", expected: "Thursday", claims: ids("meeting-g", "meeting-c") },
  ],
  footprintNoise: [
    { entity: "intern-training", rule: "repeat", why: "Finished work: Farhan ran three intern training sessions in June and July; the cards T-003 and T-004 are Done and nothing happened in the last 30 days. Expected dropped." },
    { entity: "pipeline-env", rule: "repeat|ownership", why: "Part of R01 (Nightly QC and assembly pipeline); merge into R01, not a separate responsibility." },
    { entity: "(none)", rule: "none", why: "The move off the old Tapti cluster (T-005, T-006, Done in August) and the symposium poster (T-009, T-010, Done in September) are finished and match no entity: they must not become responsibilities." },
  ],
  corroborated: [
    ids("run-p", "run-r"), ids("rev-state-n", "rev-state-t"), ids("rev-due-g", "rev-due-t", "rev-due-c"), ids("raw-new", "raw-yaml"),
    ids("ds-state-n", "ds-state-t"), ids("seq-contact-g", "seq-contact-n"), ids("seq-new-c", "seq-new-n"), ids("helix-contact-n", "helix-contact-t"),
    ids("helix-due-t", "helix-due-c"), ids("bio-cadence-g", "bio-cadence-c"), ids("bio-new-c", "bio-new-t", "bio-new-n"), ids("hpc-cadence-g", "hpc-cadence-t"),
    ids("meeting-g", "meeting-c"),
  ],
  sensitivityPlaceholders: [
    { where: "data/lab/slack/lab-general/lab-general.json", contains: "Imran is on medical leave until 23 October.", proposedCategory: "health" },
    { where: "data/lab/slack/lab-general/lab-general.json", contains: "Stipend arrears for the two PhD students for August and September will be paid with the October stipend.", proposedCategory: "hr" },
    { where: "data/lab/slack/lab-general/lab-general.json", contains: "Tara, your conference reimbursement of Rs 18,400 was approved by accounts today.", proposedCategory: "finance" },
  ],
  firstWeeks: {
    example: {
      responsibility: "R07", checkKey: "next_due_date", date: "2026-11-16",
      note: "Gauri confirmed the freezer check is every Monday morning. The next one is Monday 16 Nov. If the alarm sounds, call the facilities desk.",
      expected: { gapCloses: true, blockingDelta: -1, conflictsDelta: 0 },
    },
  },
  demoAnswer: {
    responsibility: "R01", checkKey: "credential_owner", role: "leaving_postdoc",
    text: "Gauri holds it in the lab password manager. I showed her on 6 Nov. Ask her, never post it in a channel.",
  },
  expectedSuccessorBlockingGaps: 7,
};
write("ground_truth.json", json(gt));
console.log(`generated data/lab: ${claims.length} planted claims`);
