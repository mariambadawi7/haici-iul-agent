import { readFileSync } from "node:fs";
const body = readFileSync(process.argv[2], "utf8");

// Run the Code node body with n8n's globals mocked.
function run({ userText, visitorName = "", visitor = undefined }) {
  const items = [{ json: { userText, visitorName } }];
  const $input = { all: () => items };
  const $ = (name) => {
    if (name !== "Webhook") throw new Error(`no node ${name}`);
    return { first: () => ({ json: { body: { visitor } } }) };
  };
  const fn = new Function("$input", "$", `${body}`);
  return fn($input, $)[0].json;
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};
const checkT = (label, cond) => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); };

// Baseline: an ordinary question is keyed shared, whoever asks.
const anon  = run({ userText: "when do applications close" });
const named = run({ userText: "when do applications close", visitorName: "Mariam Badawi",
                    visitor: { uid: "v0c251af469", name: "Mariam Badawi" } });
check("ordinary question keys identically for anon and bound", anon.questionHash, named.questionHash);
check("ordinary question gets no visitor context", named.visitorContext, "");

// Identity question: private key, and it must key on the UID.
const idUid  = run({ userText: "who am i", visitorName: "Mariam Badawi",
                     visitor: { uid: "v0c251af469", name: "Mariam Badawi" } });
const idName = run({ userText: "who am i", visitorName: "Mariam Badawi" });
const idAnon = run({ userText: "who am i" });
checkT("identity question is private (differs from anonymous)", idUid.questionHash !== idAnon.questionHash);
checkT("uid and name produce DIFFERENT private keys", idUid.questionHash !== idName.questionHash);

// Two people sharing a display name must not share a namespace.
const twinA = run({ userText: "who am i", visitorName: "Ali Hassan", visitor: { uid: "v1111111111", name: "Ali Hassan" } });
const twinB = run({ userText: "who am i", visitorName: "Ali Hassan", visitor: { uid: "v2222222222", name: "Ali Hassan" } });
checkT("same name, different uid -> different keys", twinA.questionHash !== twinB.questionHash);

// Staff-enrolled face: uid IS the gallery label, so keys must be unchanged.
const staffOld = run({ userText: "who am i", visitorName: "Mariam Badawi" });
const staffNew = run({ userText: "who am i", visitorName: "Mariam Badawi", visitor: { uid: "Mariam Badawi", name: "Mariam Badawi" } });
check("staff-enrolled key is unchanged by this patch", staffNew.questionHash, staffOld.questionHash);

// Greeting fence still holds (couldCarryName).
const greetBound = run({ userText: "hello", visitorName: "Mariam Badawi", visitor: { uid: "v0c251af469" } });
const greetAnon  = run({ userText: "hello" });
checkT("greeting from a bound visitor is keyed privately", greetBound.questionHash !== greetAnon.questionHash);

// Profile reaches the prompt ONLY on identity questions.
const prof = { uid: "v0c251af469", name: "Mariam Badawi",
               profile: { displayName: "Mariam Badawi", facts: [{ key: "faculty", value: "Engineering" }, { key: "year", value: "third" }] } };
const ordinaryWithProfile = run({ userText: "where is the library", visitorName: "Mariam Badawi", visitor: prof });
const identityWithProfile = run({ userText: "what do you know about me", visitorName: "Mariam Badawi", visitor: prof });
check("profile withheld on an ordinary question", ordinaryWithProfile.visitorContext, "");
checkT("profile present on an identity question", identityWithProfile.visitorContext.includes("faculty: Engineering"));
checkT("name still present on an identity question", identityWithProfile.visitorContext.includes("Mariam Badawi"));

// Anonymous visitor who volunteered facts but no name.
const anonProf = run({ userText: "what do you know about me", visitor: { uid: "v9999999999", profile: { displayName: null, facts: [{ key: "faculty", value: "Law" }] } } });
checkT("anonymous-but-known visitor still gets their facts", anonProf.visitorContext.includes("faculty: Law"));
checkT("...and is not addressed by a uid", !anonProf.visitorContext.includes("v9999999999"));

// Robustness: the node must never throw on a turn with no visitor at all.
checkT("no visitor object -> no context, no throw", run({ userText: "hi there" }).visitorContext === "");
checkT("malformed facts are survived", run({ userText: "who am i", visitor: { uid: "v3", profile: { facts: "not-an-array" } } }).visitorContext !== undefined);
checkT("null facts entries are survived", run({ userText: "who am i", visitorName: "X", visitor: { uid: "v4", profile: { facts: [null, { key: "a", value: "b" }] } } }).visitorContext.includes("a: b"));

// Arabic path unchanged.
const ar = run({ userText: "من انا", visitorName: "مريم", visitor: { uid: "v0c251af469" } });
check("arabic identity question detected", ar.isPersonalQuestion, true);
check("arabic language tag", ar.questionLanguage, "ar");

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall checks passed");
process.exit(fails ? 1 : 0);
