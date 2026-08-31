CREATE TABLE IF NOT EXISTS receptionist_session_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    input_type TEXT NOT NULL,
    question TEXT,
    answer TEXT,
    responded_with_audio BOOLEAN,
    match_type TEXT,
    answer_hash TEXT,
    session_id TEXT,
    question_hash TEXT,
    normalized_question TEXT,
    latency_ms INTEGER,
    is_unknown BOOLEAN DEFAULT FALSE,
    intent TEXT,
    language TEXT,
    raw_question TEXT,
    corrections JSONB
);

CREATE INDEX IF NOT EXISTS idx_rsl_timestamp  ON receptionist_session_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_rsl_qhash      ON receptionist_session_logs (question_hash);
CREATE INDEX IF NOT EXISTS idx_rsl_session    ON receptionist_session_logs (session_id);
CREATE INDEX IF NOT EXISTS idx_rsl_unknown    ON receptionist_session_logs (is_unknown) WHERE is_unknown;

-- Generic key/value store for admin settings. The dashboard has TWO passcodes,
-- each stored as a SHA-256 hash — never the plaintext, and never committed via
-- this file. The workflow's "Resolve Role" node matches the supplied passcode
-- against both and returns 'operator', 'client' or '' (401):
--
--   operator_passcode_sha256  full console: analytics + lexicon + branding
--   client_passcode_sha256    analytics only; lexicon/corrections return 403
--
-- Seed both manually after a fresh volume init, e.g.:
--   INSERT INTO admin_settings (key, value) VALUES ('operator_passcode_sha256', '<sha256-hex>');
--   INSERT INTO admin_settings (key, value) VALUES ('client_passcode_sha256',   '<sha256-hex>');
--
-- The operator passcode must ALSO be set as OPERATOR_PASSCODE in the web
-- container (docker-compose.yml reads it from ADMIN_DASHBOARD_PASSCODE), because
-- the Branding tab forwards it to the Bun sidecar, which gates writes on it.
-- Without it the sidecar refuses branding writes with a 503.
--
-- Superseded: 'admin_passcode_sha256' was the single pre-split passcode. Nothing
-- reads it any more.
CREATE TABLE IF NOT EXISTS admin_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Typo-tolerance lexicon. Applies to BOTH spoken and typed turns: speech
-- mishearings (Whisper hears "IOM" for IUL) and keyboard slips ("iull",
-- "wardaneih") resolve against the same term list.
-- Shape is FIXED (consumed by both the workflow's "Correct Domain Terms"
-- node and the admin dashboard's lexicon editor) - do not rename fields.
-- Seeded once; safe to re-run on a fresh volume.
INSERT INTO admin_settings (key, value) VALUES (
  'typo_lexicon',
  '{"version":1,"updatedAt":"2026-08-23T00:00:00Z","thresholds":{"autoApply":0.86,"clarify":0.72,"gap":0.08,"minFuzzyLen":5},"stoplist":["where","when","what","which","who","why","how","the","is","are","a","an","of","in","on","at","to","for","and","or","do","does","i","need","can","you","tell","me","about","from","with","that","this","it","my","your"],"terms":[{"canonical":"IUL","aliases":["iom","i o m","ioul","eul","ewl","yul","i u l","the ul","aol","ayol","iyul","aiul","a u l","the yul","iull","uil","iu","ul","ilu"],"fuzzy":false},{"canonical":"الجامعة الإسلامية في لبنان","aliases":["الجامعة الاسلامية في لبنان","الجامعه الاسلاميه"],"fuzzy":false},{"canonical":"HAICI","aliases":["hi ci","hi see","hyacy","haasi","ha ici","high see","hoisy","hi c","hey see","hisci","hi sci","high sci"],"fuzzy":true},{"canonical":"Khaldeh","aliases":["khalde","kalde","haldeh","khaldia","cald day","kaldeh"],"fuzzy":true},{"canonical":"خلدة","aliases":["خلده","خالده"],"fuzzy":true},{"canonical":"Wardanieh","aliases":["wardania","wardaniyeh","verdania","wardanya","warda nia","wardaniya"],"fuzzy":true},{"canonical":"الوردانية","aliases":["الورداني","الورضانية"],"fuzzy":true},{"canonical":"Tyre","aliases":["sour","soor","tayr","tire","sor","soure"],"fuzzy":true},{"canonical":"صور","aliases":["سور"],"fuzzy":true},{"canonical":"Baalbek","aliases":["baalbeck","balbek","baalback","baalbak","bal bek","baal bek"],"fuzzy":true},{"canonical":"بعلبك","aliases":["بعلبيك"],"fuzzy":true},{"canonical":"Bourj El Barajneh","aliases":["burj barajne","borj barajneh","burj al barajneh","borj el barajni","burj barajni"],"fuzzy":true},{"canonical":"برج البراجنة","aliases":["برج البراجنه"],"fuzzy":true},{"canonical":"Majdal Balhiss","aliases":["majdal balhis","majdal balhees","majdal belhis","majdel balhiss"],"fuzzy":true},{"canonical":"Sahmar","aliases":["sahmar","sahmer","sahmir"],"fuzzy":true},{"canonical":"Moussa El-Sader","aliases":["musa sadr","moussa sadr","musa al sadr","moussa alsader","musa al-sader","moussa el sadr"],"fuzzy":true},{"canonical":"Shams Al-Din","aliases":["shamsedin","shams eddine","shamseddin","shams al din","shamseldin"],"fuzzy":true},{"canonical":"Abdul Amir Qablan","aliases":["abdul amir kablan","abdulamir qablan","abdel amir qablan","abdul amir cablan"],"fuzzy":true},{"canonical":"Hassan Al-Laqis","aliases":["hassan lakis","hassan al-laqees","hassan alaqis","hassan al akis","hassan el laqis"],"fuzzy":true},{"canonical":"Rodayna Hmede","aliases":["rudayna hmaidi","rodina hmede","rudaina hmede","rodaina hmadeh"],"fuzzy":true},{"canonical":"HCERES","aliases":["h series","aitch ceres","h ceres","aitch series","hseries"],"fuzzy":false},{"canonical":"ECTS","aliases":["e c t s","ects","eects","e cts"],"fuzzy":false},{"canonical":"Baccalaureate","aliases":["baccalaureat","bacalaureate","baccalaureah","the bac","bacc","baccalaureah degree"],"fuzzy":true},{"canonical":"Order of Engineers","aliases":["order of engineering","order engineers","order of the engineers"],"fuzzy":true}]}'
) ON CONFLICT (key) DO NOTHING;
