import { readFileSync } from "node:fs";
const src = readFileSync(process.argv[2], "utf8");

function run(visitor, output, asked = "") {
  const $json = { output };
  const $ = (n) => {
    if (n === "Webhook") return { first: () => ({ json: { body: { visitor } } }) };
    if (n === "Correct Domain Terms")
      return { isExecuted: true, first: () => ({ json: { userText: asked } }) };
    throw new Error("no node " + n);
  };
  return new Function("$json", "$", `return (${src});`)($json, $);
}

let fails = 0;
const t = (label, got, want) => { const ok = got === want; if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (noCache=${got})`); };

const mariam = { name: "Mariam Badawi", uid: "v0c251af469",
  profile: { displayName: "Mariam Badawi", facts: [{ key: "year", value: "third year" }] } };

// The exact live leak this fence exists for.
t("the observed leak is now blocked", run(mariam, "You are Mariam Badawi, a third-year student in the Faculty of Engineering."), true);
t("name alone blocks caching", run(mariam, "Hello Mariam Badawi, the deadline is in May."), true);
t("a stored fact blocks caching", run(mariam, "As someone in their third year, you should apply now."), true);

// The whole point is that ordinary answers stay cacheable.
t("impersonal answer stays cacheable", run(mariam, "Applications close on 15 September."), false);
t("long factual answer stays cacheable", run(mariam, "The university has faculties of Law, Sciences and Public Health."), false);
t("no visitor at all -> cacheable", run(undefined, "Applications close on 15 September."), false);
t("bound but nothing known -> cacheable", run({ uid: "v1", name: null, profile: null }, "Applications close in May."), false);

// Case and substring handling.
t("case-insensitive match", run(mariam, "hello mariam badawi!"), true);
t("partial-name match still blocks", run(mariam, "Badawi, your form is ready."), false); // full name needle only
t("anonymous visitor's facts still fence", run({ uid: "v2", profile: { displayName: null, facts: [{ key: "faculty", value: "Law" }] } }, "You study Law here."), true);

// The question side. A cached record stores it too, so a name there is just as
// exposed as one in the answer -- found live by cache_key_audit.py.
t("name in the QUESTION blocks caching", run(mariam, "Thank you.", "i am Mariam Badawi"), true);
t("a stored fact in the question blocks caching", run(mariam, "Noted.", "i am in my third year"), true);
t("impersonal question + impersonal answer stays cacheable", run(mariam, "Applications close in May.", "when do applications close"), false);
t("no Correct Domain Terms run -> answer side still checked", (() => {
  const $ = (n) => {
    if (n === "Webhook") return { first: () => ({ json: { body: { visitor: mariam } } }) };
    return { isExecuted: false, first: () => { throw new Error("did not run"); } };
  };
  return new Function("$json", "$", `return (${src});`)({ output: "Hello Mariam Badawi." }, $);
})(), true);

// Fail closed.
t("unreadable visitor -> not cached", (() => {
  const $ = () => { throw new Error("Webhook did not execute"); };
  return new Function("$json", "$", `return (${src});`)({ output: "anything" }, $);
})(), true);

// Degenerate inputs must not throw.
t("empty answer -> cacheable", run(mariam, ""), false);
t("short facts are ignored (noise floor)", run({ uid: "v3", profile: { facts: [{ key: "x", value: "II" }] } }, "Room II is upstairs."), false);

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall checks passed");
process.exit(fails ? 1 : 0);
