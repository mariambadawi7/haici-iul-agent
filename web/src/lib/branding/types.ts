/**
 * The tenant configuration contract.
 *
 * One JSON document describes everything that differs between the businesses
 * this product is sold to. It is loaded at runtime (see `store.ts`) so a
 * client can be rebranded from the admin UI without a rebuild or redeploy.
 *
 * Every field is optional on the wire — `defaults.ts` fills the gaps, so a
 * partial or hand-edited file degrades to sane neutral branding instead of a
 * blank screen.
 */

export type ThemeMode = "light" | "dark";

/** How the assistant is represented on screen. */
export type AvatarKind = "glb" | "image" | "none";

export interface BrandIdentity {
  /** Product name shown in the brand strip, status card and browser tab. */
  name: string;
  /** Small all-caps kicker above the name, e.g. "ACME • KAILYRA". */
  kicker: string;
  /** One-line description under the name. */
  tagline: string;
  /** Primary (client) logo, left of the brand strip. Empty hides the slot. */
  logoPrimary: string;
  /** Secondary (vendor/partner) logo, right of the brand strip. */
  logoSecondary: string;
  /** Browser tab icon. */
  favicon: string;
  /** Attribution line in the footer. Empty removes the footer entirely. */
  footerCredit: string;
  /** <meta name="description"> for the document. */
  metaDescription: string;
}

export interface BrandTheme {
  /** Anchor colour for every accent surface — buttons, focus rings, active states. */
  brand: string;
  /** Neutral anchor driving all greys: panels, borders, body copy. */
  neutral: string;
  /** Warning/attention colour — health banner, mock-data badges. */
  warn: string;
  /** Page and panel background in light mode; auto-darkened for dark mode. */
  surface: string;
  mode: ThemeMode;
  /** Any font family name; loaded from Google Fonts at runtime if not local. */
  fontSans: string;
  fontSerif: string;
  /** Corner rounding for panels and controls, as a CSS length. */
  radius: string;
}

export interface BrandAvatar {
  kind: AvatarKind;
  /** GLB with ARKit/Oculus blendshapes, used when kind === "glb". */
  glbUrl: string;
  /** Still image, used when kind === "image" and on the landing hero. */
  imageUrl: string;
}

export interface BrandFeatures {
  /** Microphone input and spoken replies. */
  voice: boolean;
  /** The animated assistant panel. */
  avatar: boolean;
  /** The splash screen shown before the first conversation. */
  landing: boolean;
  /** The #/admin analytics dashboard. */
  admin: boolean;
  /** Conversation history rail. */
  sidebar: boolean;
}

/**
 * Brand-bound copy. Not a general i18n layer — just the handful of strings
 * that name the client's own subject matter and would otherwise still read
 * "IUL" on someone else's kiosk.
 */
export interface BrandContent {
  /** Placeholder in the message box. */
  inputPlaceholder: string;
  /** Starter prompts on the empty chat screen. */
  suggestions: string[];
}

export interface TenantConfig {
  /** Stable slug. Namespaces browser storage so two tenants can share an origin. */
  id: string;
  identity: BrandIdentity;
  theme: BrandTheme;
  avatar: BrandAvatar;
  features: BrandFeatures;
  content: BrandContent;
}

/** What the admin UI and the config file may send: any subset, any depth. */
export type PartialTenantConfig = {
  [K in keyof TenantConfig]?: TenantConfig[K] extends object
    ? Partial<TenantConfig[K]>
    : TenantConfig[K];
};
