/**
 * The white-label control panel.
 *
 * Everything a client can change about the product's appearance is edited
 * here and written to the tenant config, so rebranding an installation never
 * requires a developer, an env var or a rebuild. Edits apply to the live
 * document as you type (the preview IS the app), and only reach disk on Save —
 * Discard puts the last saved state back.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  Loader2,
  Palette,
  RotateCcw,
  Save,
  Sparkles,
  Type,
  Upload,
} from "lucide-react";
import { Panel } from "./ui";
import { useBranding } from "../../lib/branding/context";
import { DEFAULT_CONFIG } from "../../lib/branding/defaults";
import { saveBranding, uploadAsset, type AssetSlot } from "../../lib/branding/store";
import type { AvatarKind, TenantConfig, ThemeMode } from "../../lib/branding/types";

interface Props {
  /** Forwarded to the config service, which may require it for writes. */
  passcode: string | null;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export default function BrandingTab({ passcode }: Props) {
  const { config, update } = useBranding();

  // The last state known to be on disk. Discard rewinds to this, and it is
  // what makes the "unsaved changes" indicator honest.
  const [saved, setSaved] = useState<TenantConfig>(config);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(saved),
    [config, saved],
  );

  /** Patch one section and repaint immediately — this is the live preview. */
  const set = useCallback(
    <K extends keyof TenantConfig>(section: K, patch: Partial<TenantConfig[K]>) => {
      update({ ...config, [section]: { ...(config[section] as object), ...patch } });
      setStatus({ kind: "idle" });
    },
    [config, update],
  );

  async function handleSave() {
    setStatus({ kind: "saving" });
    const result = await saveBranding(config, passcode);
    if (result.ok) {
      setSaved(config);
      setStatus({ kind: "saved" });
      setTimeout(() => setStatus({ kind: "idle" }), 2500);
    } else {
      setStatus({ kind: "error", message: result.error ?? "Save failed." });
    }
  }

  function handleDiscard() {
    update(saved);
    setStatus({ kind: "idle" });
  }

  function handleReset() {
    update({ ...DEFAULT_CONFIG, id: config.id });
    setStatus({ kind: "idle" });
  }

  return (
    <Panel
      title="Branding"
      subtitle="Changes preview instantly. Nothing is stored until you save."
      action={
        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-[11px] uppercase tracking-widest text-warn-600">
              Unsaved
            </span>
          )}
          <button
            type="button"
            onClick={handleDiscard}
            disabled={!dirty || status.kind === "saving"}
            className="btn-ghost text-xs px-3 py-1.5"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || status.kind === "saving"}
            className="btn-primary text-xs px-3 py-1.5"
          >
            {status.kind === "saving" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : status.kind === "saved" ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            {status.kind === "saved" ? "Saved" : "Save"}
          </button>
        </div>
      }
    >
      {status.kind === "error" && (
        <div className="mb-4 text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
          {status.message}
        </div>
      )}

      <Section icon={<Type className="w-3.5 h-3.5" />} title="Identity">
        <Field
          label="Tenant ID"
          hint="Namespaces stored conversations. Change only on a fresh install."
        >
          <input
            className="input"
            value={config.id}
            onChange={(e) => update({ ...config, id: e.target.value })}
          />
        </Field>
        <Field
          label="Product name"
          hint="Shown in the masthead, status card and browser tab."
        >
          <input
            className="input"
            value={config.identity.name}
            onChange={(e) => set("identity", { name: e.target.value })}
          />
        </Field>
        <Field
          label="Kicker"
          hint="Small uppercase line above the name. Leave empty to hide."
        >
          <input
            className="input"
            value={config.identity.kicker}
            onChange={(e) => set("identity", { kicker: e.target.value })}
          />
        </Field>
        <Field label="Tagline">
          <input
            className="input"
            value={config.identity.tagline}
            onChange={(e) => set("identity", { tagline: e.target.value })}
          />
        </Field>
        <Field
          label="Footer credit"
          hint="Attribution line. Empty removes the footer entirely."
        >
          <input
            className="input"
            value={config.identity.footerCredit}
            onChange={(e) => set("identity", { footerCredit: e.target.value })}
          />
        </Field>
        <Field label="Search description" hint="Used as the page's meta description.">
          <input
            className="input"
            value={config.identity.metaDescription}
            onChange={(e) => set("identity", { metaDescription: e.target.value })}
          />
        </Field>
      </Section>

      <Section icon={<Upload className="w-3.5 h-3.5" />} title="Logos & artwork">
        <AssetField
          label="Primary logo"
          hint="Left of the masthead — usually the client's own mark."
          slot="logo-primary"
          value={config.identity.logoPrimary}
          passcode={passcode}
          onChange={(url) => set("identity", { logoPrimary: url })}
        />
        <AssetField
          label="Secondary logo"
          hint="Right of the masthead — a partner or vendor mark. Optional."
          slot="logo-secondary"
          value={config.identity.logoSecondary}
          passcode={passcode}
          onChange={(url) => set("identity", { logoSecondary: url })}
        />
        <AssetField
          label="Favicon"
          hint="Browser tab icon."
          slot="favicon"
          value={config.identity.favicon}
          passcode={passcode}
          onChange={(url) => set("identity", { favicon: url })}
        />
      </Section>

      <Section icon={<Palette className="w-3.5 h-3.5" />} title="Theme">
        <ColorField
          label="Brand colour"
          hint="Buttons, focus rings, highlights. A full tint and shade range is generated from this one colour."
          value={config.theme.brand}
          onChange={(brand) => set("theme", { brand })}
        />
        <ColorField
          label="Neutral colour"
          hint="Drives every grey: panels, borders, body text."
          value={config.theme.neutral}
          onChange={(neutral) => set("theme", { neutral })}
        />
        <ColorField
          label="Attention colour"
          hint="Warnings and status banners."
          value={config.theme.warn}
          onChange={(warn) => set("theme", { warn })}
        />
        <ColorField
          label="Surface colour"
          hint="Panel background in light mode."
          value={config.theme.surface}
          onChange={(surface) => set("theme", { surface })}
        />
        <Field label="Mode">
          <select
            className="input"
            value={config.theme.mode}
            onChange={(e) => set("theme", { mode: e.target.value as ThemeMode })}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <Field
          label="Body font"
          hint="Any Google Fonts family name, e.g. Inter, Rubik, Cairo."
        >
          <input
            className="input"
            value={config.theme.fontSans}
            onChange={(e) => set("theme", { fontSans: e.target.value })}
          />
        </Field>
        <Field label="Display font" hint="Used for headings and the serif labels.">
          <input
            className="input"
            value={config.theme.fontSerif}
            onChange={(e) => set("theme", { fontSerif: e.target.value })}
          />
        </Field>
        <Field
          label="Corner rounding"
          hint="A CSS length — 0rem for square, 1rem default, 1.75rem for very soft."
        >
          <input
            className="input"
            value={config.theme.radius}
            onChange={(e) => set("theme", { radius: e.target.value })}
          />
        </Field>
      </Section>

      <Section icon={<Sparkles className="w-3.5 h-3.5" />} title="Assistant & content">
        <Field label="Avatar type">
          <select
            className="input"
            value={config.avatar.kind}
            onChange={(e) => set("avatar", { kind: e.target.value as AvatarKind })}
          >
            <option value="glb">Animated 3D model</option>
            <option value="image">Still image</option>
            <option value="none">No avatar</option>
          </select>
        </Field>
        <AssetField
          label="3D model (.glb)"
          hint="Needs ARKit or Oculus blendshapes for lip-sync. A Ready Player Me export works."
          slot="avatar-model"
          value={config.avatar.glbUrl}
          passcode={passcode}
          onChange={(url) => set("avatar", { glbUrl: url })}
        />
        <AssetField
          label="Still artwork"
          hint="Hero image on the welcome screen, and the avatar itself in still mode."
          slot="avatar-image"
          value={config.avatar.imageUrl}
          passcode={passcode}
          onChange={(url) => set("avatar", { imageUrl: url })}
        />
        <Field label="Input placeholder">
          <input
            className="input"
            value={config.content.inputPlaceholder}
            onChange={(e) => set("content", { inputPlaceholder: e.target.value })}
          />
        </Field>
        <Field
          label="Starter prompts"
          hint="One per line. Shown as tappable chips on an empty conversation."
        >
          <textarea
            className="input resize-y min-h-[7rem]"
            value={config.content.suggestions.join("\n")}
            onChange={(e) =>
              set("content", {
                suggestions: e.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </Section>

      <Section icon={<Check className="w-3.5 h-3.5" />} title="Features">
        <p className="text-xs text-slate-500 -mt-1 mb-2">
          Switch off anything you don't want. Hidden features are removed from
          the interface, not merely greyed out.
        </p>
        <Toggle
          label="Voice input and spoken replies"
          checked={config.features.voice}
          onChange={(voice) => set("features", { voice })}
        />
        <Toggle
          label="Assistant avatar panel"
          checked={config.features.avatar}
          onChange={(avatar) => set("features", { avatar })}
        />
        <Toggle
          label="Welcome screen"
          checked={config.features.landing}
          onChange={(landing) => set("features", { landing })}
        />
        <Toggle
          label="Conversation history rail"
          checked={config.features.sidebar}
          onChange={(sidebar) => set("features", { sidebar })}
        />
        <Toggle
          label="Analytics dashboard"
          checked={config.features.admin}
          onChange={(admin) => set("features", { admin })}
          warning="Turning this off hides this dashboard after the next reload. Re-enable it by editing branding.json on the host."
        />
      </Section>

      <div className="pt-5 mt-5 border-t border-slate-200">
        <button
          type="button"
          onClick={handleReset}
          className="btn-ghost text-xs px-3 py-1.5"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset to unbranded defaults
        </button>
        <p className="text-[11px] text-slate-400 mt-2">
          Clears every customisation except the tenant ID. Still needs Save.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Form atoms
// ---------------------------------------------------------------------------

function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="py-5 border-t border-slate-200 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-2 text-[11px] uppercase tracking-[0.25em] text-slate-500 mb-4">
        {icon}
        {title}
      </h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {hint && <span className="block text-[11px] text-slate-400 mt-0.5">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-14 rounded-xl border border-slate-200 bg-surface p-1 cursor-pointer shrink-0"
          aria-label={`${label} picker`}
        />
        <input
          className="input font-mono text-sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      </div>
    </Field>
  );
}

function AssetField({
  label,
  hint,
  slot,
  value,
  passcode,
  onChange,
}: {
  label: string;
  hint?: string;
  slot: AssetSlot;
  value: string;
  passcode: string | null;
  onChange: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const result = await uploadAsset(slot, file, passcode);
    setBusy(false);
    if (result.ok && result.url) onChange(result.url);
    else setError(result.error ?? "Upload failed.");
  }

  // A .glb has nothing to preview; everything else in these slots is an image.
  const previewable = value && !value.toLowerCase().endsWith(".glb");

  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        {previewable && (
          <img
            src={value}
            alt=""
            className="h-11 w-11 rounded-xl border border-slate-200 object-contain bg-surface p-1 shrink-0"
          />
        )}
        <input
          className="input text-sm"
          value={value}
          placeholder="Upload a file, or paste a URL"
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="btn-ghost text-xs px-3 py-2.5 shrink-0"
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Upload className="w-3.5 h-3.5" />
          )}
          Upload
        </button>
      </div>
      {error && <p className="text-[11px] text-red-600 mt-1">{error}</p>}
    </Field>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  warning,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  warning?: string;
}) {
  return (
    <div>
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400/40"
        />
        <span className="text-sm text-slate-700">{label}</span>
      </label>
      {warning && !checked && (
        <p className="text-[11px] text-warn-700 mt-1 ml-7">{warning}</p>
      )}
    </div>
  );
}
