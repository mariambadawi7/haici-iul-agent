/**
 * The tenant's masthead.
 *
 * This markup used to exist twice — once in `App.tsx` and once in
 * `LandingPage.tsx` — with the logos, kicker and tagline hardcoded in both
 * copies. Every field now comes from the tenant config, and both screens
 * render this one component so a rebrand can never land in one place and miss
 * the other. Logo slots collapse when the config leaves them empty.
 */

import type { ReactNode } from "react";
import { useTenant } from "../lib/branding/context";

interface Props {
  /** Rendered next to the secondary logo — e.g. the "back to welcome" button. */
  actions?: ReactNode;
  className?: string;
}

export default function BrandStrip({ actions, className = "" }: Props) {
  const { identity } = useTenant();

  return (
    <section
      className={`brand-strip panel-elevated border-b border-bg-border shrink-0 ${className}`}
    >
      <div className="brand-row">
        <div className="brand-icon-wrap">
          {identity.logoPrimary && (
            <img
              src={identity.logoPrimary}
              alt={`${identity.name} logo`}
              className="brand-icon"
            />
          )}
        </div>

        <div className="brand-copy">
          {identity.kicker && <div className="brand-label">{identity.kicker}</div>}
          <h2 className="brand-heading">{identity.name}</h2>
          {identity.tagline && (
            <p className="brand-subtitle">{identity.tagline}</p>
          )}
        </div>

        <div className="brand-right-actions flex items-center gap-3 md:gap-5">
          {identity.logoSecondary && (
            <div className="brand-icon-wrap hidden sm:block">
              <img
                src={identity.logoSecondary}
                alt="Partner logo"
                className="brand-icon"
              />
            </div>
          )}
          {actions}
        </div>
      </div>
    </section>
  );
}

/** Footer attribution. Renders nothing when the tenant has cleared the credit. */
export function BrandFooter() {
  const { identity } = useTenant();
  if (!identity.footerCredit) return null;
  return <div className="footer-credit">{identity.footerCredit}</div>;
}
