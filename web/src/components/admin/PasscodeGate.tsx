import { useState, type FormEvent } from "react";
import { Lock, ShieldAlert } from "lucide-react";

interface Props {
  onSubmit: (passcode: string) => Promise<boolean>;
  mock?: boolean;
}

export default function PasscodeGate({ onSubmit, mock }: Props) {
  const [passcode, setPasscode] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!passcode.trim() || checking) return;
    setChecking(true);
    setError(null);
    try {
      const ok = await onSubmit(passcode);
      if (!ok) setError("Incorrect passcode.");
    } catch (err: any) {
      setError(err?.message || "Could not verify the passcode.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center app-shell bg-slate-50 px-4">
      <div className="panel-elevated rounded-2xl border border-slate-200/80 shadow-soft w-full max-w-sm p-8 animated-entry">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="h-12 w-12 rounded-full bg-teal-50 border border-teal-200 grid place-items-center mb-3">
            <Lock className="w-5 h-5 text-teal-600" />
          </div>
          <div className="badge-serif">Admin</div>
          <h1 className="font-serif text-xl text-slate-900 mt-1">
            Analytics Dashboard
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Enter the passcode to view usage analytics.
          </p>
          {mock && (
            <span className="mt-3 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1">
              Mock data mode
            </span>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            autoFocus
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Passcode"
            className="input"
            autoComplete="off"
            disabled={checking}
          />
          {error && (
            <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <button
            type="submit"
            disabled={checking || !passcode.trim()}
            className="btn-primary w-full"
          >
            {checking ? "Verifying…" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
