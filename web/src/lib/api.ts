const env = import.meta.env;

export const config = {
  chatUrl: (env.VITE_N8N_WEBHOOK_URL as string) || "/webhook/rag-agent",
  /** Optional second endpoint that takes { text } and returns audio only.
   *  When set, the UI does the chat turn in TWO requests:
   *    1) chatUrl → text answer (fast, no Piper in path)
   *    2) ttsUrl  → WAV for the answer (parallel with rendering text)
   *  Massively reduces "long response times out" failures. */
  ttsUrl: (env.VITE_N8N_TTS_URL as string) || "",
  logoLeft: (env.VITE_LOGO_LEFT as string) || "",
  logoRight: (env.VITE_LOGO_RIGHT as string) || "",
  title: (env.VITE_APP_TITLE as string) || "IUL Agent",
};

export const twoStage = !!config.ttsUrl;

export interface ChatReply {
  answer: string;
  audio?: Blob;
  question?: string;
  /** Present when the workflow's error responder fired — `answer` already
   *  contains a friendly message, this is the raw error for diagnostics. */
  error?: string;
  /** Workflow node where the error happened, if known. */
  stage?: string;
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function parseReply(data: any): ChatReply {
  const answer =
    data.answer ??
    data.reply ??
    data.response ??
    data.message ??
    data.output ??
    data.text ??
    "";
  const reply: ChatReply = { answer: String(answer) };
  if (data.audioBase64) {
    reply.audio = base64ToBlob(data.audioBase64, data.audioMime || "audio/wav");
  }
  if (data.question) reply.question = String(data.question);
  if (data.error) reply.error = String(data.error);
  if (data.stage) reply.stage = String(data.stage);
  return reply;
}

async function readReply(res: Response): Promise<ChatReply> {
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        "Workflow not found. Activate the workflow in n8n — /webhook-test/... only fires once per Listen click; the production route is /webhook/...",
      );
    }
    if (res.status === 502 || res.status === 503) {
      throw new Error(
        "Vite couldn't reach the n8n container. Restart with: docker compose up -d --force-recreate n8n web",
      );
    }
    if (res.status === 504 || res.status === 408) {
      throw new Error("The workflow took too long to respond.");
    }
    throw new Error(`Chat backend returned HTTP ${res.status}`);
  }
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error(
      "The response was cut off before the browser could read it.",
    );
  }
  if (!body.trim()) {
    throw new Error(
      "Workflow returned an empty response. Make sure the workflow is Active and /webhook/rag-agent (not /webhook-test) is the URL.",
    );
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return { answer: body.trim() };
  }
  try {
    return parseReply(JSON.parse(body));
  } catch {
    return { answer: body.trim() };
  }
}

/** Wraps fetch with an AbortController + timeout so a stalled request doesn't hang forever. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 90_000,
): Promise<Response> {
  const ctl = new AbortController();
  const externalSignal = init.signal;
  if (externalSignal) {
    if (externalSignal.aborted) ctl.abort();
    else
      externalSignal.addEventListener("abort", () => ctl.abort(), {
        once: true,
      });
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s. The workflow may still be running — check n8n executions.`,
      );
    }
    if (
      typeof e?.message === "string" &&
      /networkerror|failed to fetch|load failed/i.test(e.message)
    ) {
      throw new Error(
        "Could not reach the workflow through the Vite proxy. Check that the web container can resolve `n8n:5678` and that the workflow is Active.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a text turn to the n8n RAG workflow.
 * Body shape matches `Set userText (Text)` in the workflow: `body.text`.
 * `wantsAudio` lets the workflow skip Piper when the user has TTS muted.
 */
export async function sendChat(
  sessionId: string,
  text: string,
  wantsAudio: boolean,
  signal?: AbortSignal,
): Promise<ChatReply> {
  console.log("Sending chat to:", config.chatUrl, { sessionId, text, wantsAudio });
  const res = await fetchWithTimeout(config.chatUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text, wantsAudio }),
    signal,
  });
  return readReply(res);
}

/**
 * Two-stage variant: ask only for text. The workflow should skip Piper
 * when `wantsAudio:false`. We then call `synthesizeRemote` separately.
 */
export async function fetchAudio(
  text: string,
  signal?: AbortSignal,
): Promise<Blob | null> {
  if (!config.ttsUrl) return null;
  const res = await fetchWithTimeout(
    config.ttsUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    },
    60_000,
  );
  if (!res.ok) {
    console.warn("[tts] remote synth returned", res.status);
    return null;
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const data = await res.json();
    if (data.audioBase64) {
      return base64ToBlob(data.audioBase64, data.audioMime || "audio/wav");
    }
    return null;
  }
  // Raw audio body
  return await res.blob();
}

/**
 * Send a recorded audio blob to the workflow as multipart/form-data.
 * n8n's Webhook node exposes the first binary file as `$binary.data0`,
 * which the Switch routes through `Local Whisper (STT)` — so the UI
 * never talks to Whisper or Piper directly.
 */
export async function sendChatAudio(
  sessionId: string,
  blob: Blob,
  wantsAudio: boolean,
  signal?: AbortSignal,
): Promise<ChatReply> {
  const form = new FormData();
  const ext = blob.type.includes("webm") ? "webm" : "wav";
  form.append("file", blob, `speech.${ext}`);
  form.append("sessionId", sessionId);
  form.append("wantsAudio", String(wantsAudio));
  const res = await fetchWithTimeout(config.chatUrl, {
    method: "POST",
    body: form,
    signal,
  });
  return readReply(res);
}

/**
 * Directly transcribe the audio using the local Whisper instance.
 */
export async function transcribeAudio(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes("webm") ? "webm" : "wav";
  form.append("file", blob, `speech.${ext}`);
  form.append("model", "base");

  const res = await fetchWithTimeout("/stt/v1/audio/transcriptions", {
    method: "POST",
    body: form,
    signal,
  }, 90_000);

  if (!res.ok) {
    throw new Error(`Transcription failed with status ${res.status}`);
  }
  
  const data = await res.json();
  return data.text || "";
}
