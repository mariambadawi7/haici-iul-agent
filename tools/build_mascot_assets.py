#!/usr/bin/env python3
"""Turn the HAICI Mascot Animation Asset Pack into the runtime asset set.

The pack ships ~300 isolated SVGs across three different canvas registrations.
The web app only needs a handful, all normalised onto two canvases:

  * three static composites on the 2000x3200 master canvas
    (`body.svg`, `head.svg`, `antenna.svg`), so the browser loads three
    requests instead of sixteen; and
  * the swappable face overlays, kept on their own 1024x1024 canvas exactly
    as the pack authored them.

`components/Mascot2D.tsx` places the overlay canvas at master (488, 290) --
the `registration.faceOverlayTransform` from `source/rig/HAICI_Mascot_Rig.json`
-- and pivots the head and antenna on the rig's `neck` and `antenna` bones.
Those numbers are the entire contract between this script and the component;
they are re-read from the rig file and emitted as `src/lib/mascotRig.ts`
rather than hard-coded in the TSX, so a repacked character with different
registration still lands correctly.

Usage:
    python tools/build_mascot_assets.py --pack <unzipped-pack-dir>

Writes into web/public/mascot/ and web/src/lib/mascotRig.ts. The output is
committed -- rerun this only when management sends a new pack.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

# Every SVG in the pack carries a byte-identical <defs> (gradients, the soft
# glow filter, and the .outline/.thin stroke classes). Hoisting one copy is
# what makes concatenating layer bodies safe: no id can collide with itself.
DEFS_RE = re.compile(r"<defs>.*?</defs>", re.S)
BODY_RE = re.compile(r"</defs>\s*(.*?)\s*</svg>\s*$", re.S)
# Inkscape anchor crosshairs ship hidden; drop them so they cannot be revealed.
GUIDE_RE = re.compile(r'<g id="ANCHOR_GUIDE".*?</g>\s*', re.S)

# Static composites, in paint order. Members are the pack's master layer
# files, already registered on the 2000x3200 canvas.
COMPOSITES: dict[str, list[str]] = {
    "body": [
        "01_Shadows", "02_Left_Leg", "03_Right_Leg", "04_Hip_Connector",
        "05_Left_Arm", "06_Right_Arm", "07_Torso", "08_Neck",
        "09_Left_Hand", "10_Right_Hand",
    ],
    # Ears sit behind the shell in a front view but carry the cyan side glow.
    "head": ["11_Left_Ear", "12_Right_Ear", "13_Head", "14_Face_Screen"],
    "antenna": ["18_Antenna"],
}

# Face overlays copied through untouched, grouped into the folders the
# component swaps between. Left of the colon is the pack's file name, right is
# the name the component asks for.
OVERLAYS: dict[str, dict[str, str]] = {
    "eyes": {
        "eyes_neutral_open": "neutral",
        "eyes_happy_curved": "happy",
        "eyes_excited_wide": "wide",
        "eyes_focused": "focused",
        "eyes_thinking": "thinking",
        "eyes_sad": "sad",
        "eyes_worried": "worried",
        "eyes_surprised": "surprised",
        "eyes_angry": "angry",
        "eyes_confused": "confused",
        "eyes_sleepy": "sleepy",
        "eyes_closed": "closed",
        "eyes_blink_halfway": "blink_half",
        "eyes_blink_fully_closed": "blink_shut",
        "eyes_star": "star",
        "eyes_loading_dots": "loading",
    },
    "brows": {
        "eyebrows_neutral": "neutral",
        "eyebrows_raised": "raised",
        "eyebrows_lowered": "lowered",
        "eyebrows_worried": "worried",
        "eyebrows_confused": "confused",
        "eyebrows_angry": "angry",
    },
    "mouth": {
        "mouth_small_smile": "smile",
        "mouth_large_smile": "grin",
        "mouth_neutral_closed": "closed",
        "mouth_small_o": "small_o",
        "mouth_open_happy": "open_happy",
        "mouth_surprised_round": "round",
        "mouth_thinking": "thinking",
        "mouth_sad": "sad",
        "mouth_worried": "worried",
        "mouth_smirk": "smirk",
        # The 12-shape viseme set the rigging guide specifies for lip-sync.
        "lipsync/mouth_lipsync_rest": "v_rest",
        "lipsync/mouth_lipsync_closed": "v_closed",
        "lipsync/mouth_lipsync_open": "v_open",
        "lipsync/mouth_lipsync_a": "v_a",
        "lipsync/mouth_lipsync_e": "v_e",
        "lipsync/mouth_lipsync_i": "v_i",
        "lipsync/mouth_lipsync_o": "v_o",
        "lipsync/mouth_lipsync_u": "v_u",
        "lipsync/mouth_lipsync_mbp": "v_mbp",
        "lipsync/mouth_lipsync_fv": "v_fv",
        "lipsync/mouth_lipsync_l": "v_l",
        "lipsync/mouth_lipsync_wq": "v_wq",
    },
    "marks": {
        "loading_dots": "loading",
        "question_mark": "question",
        "sparkle": "sparkle",
        "exclamation_mark": "exclaim",
        "small_heart": "heart",
    },
}

# Where each overlay group lives under assets/svg/ in the pack.
OVERLAY_DIRS = {
    "eyes": "eyes",
    "brows": "eyebrows",
    "mouth": "mouths",
    "marks": "expression_marks",
}


def read_parts(path: Path) -> tuple[str, str]:
    """Return (defs, body) for one pack SVG, with anchor guides stripped."""
    text = path.read_text(encoding="utf-8")
    defs = DEFS_RE.search(text)
    body = BODY_RE.search(text)
    if not defs or not body:
        raise SystemExit(f"{path} is not shaped like a pack asset")
    return defs.group(0), GUIDE_RE.sub("", body.group(1)).strip()


def write_rig_module(rig: dict, path: Path) -> None:
    """Emit the registration the component needs as a typed TS constant.

    A JSON file in public/ would mean an extra request and a loading state in
    a component that must paint on the first frame; a generated module is
    resolved at build time instead.
    """
    bones = {b["name"]: b for b in rig["bones"]}
    face = rig["registration"]["faceOverlayTransform"]
    canvas = rig["coordinateSystem"]
    side = int(rig["registration"]["faceOverlayCanvas"].split("x")[0])
    path.write_text(
        "/**\n"
        " * Where the mascot's pieces sit on the master canvas.\n"
        " *\n"
        " * Generated by tools/build_mascot_assets.py from the pack's\n"
        " * source/rig/HAICI_Mascot_Rig.json -- do not edit by hand.\n"
        " */\n"
        "export const MASCOT_RIG = {\n"
        "  /** Canvas every layer is registered against, in mascot units. */\n"
        f'  master: {{ width: {canvas["width"]}, height: {canvas["height"]} }},\n'
        "  /** Top-left and side of the square canvas the face overlays use. */\n"
        f'  faceOverlay: {{ x: {face["x"]}, y: {face["y"]}, size: {side} }},\n'
        "  /** Rotation centres, in master units. */\n"
        "  pivots: {\n"
        f'    neck: {{ x: {bones["neck"]["x"]}, y: {bones["neck"]["y"]} }},\n'
        f'    antenna: {{ x: {bones["antenna"]["x"]}, y: {bones["antenna"]["y"]} }},\n'
        "  },\n"
        "} as const;\n",
        encoding="utf-8",
    )
    print(f"  wrote {path.name}")


def build(pack: Path, out: Path, rig_module: Path) -> None:
    rig = json.loads((pack / "source/rig/HAICI_Mascot_Rig.json").read_text("utf-8"))
    canvas = rig["coordinateSystem"]
    master_w, master_h = canvas["width"], canvas["height"]
    overlay_side = int(rig["registration"]["faceOverlayCanvas"].split("x")[0])

    layers = pack / "source/PSD_Layers/SVG"
    shared_defs = ""

    for name, members in COMPOSITES.items():
        bodies = []
        for member in members:
            defs, body = read_parts(layers / f"{member}.svg")
            shared_defs = shared_defs or defs
            bodies.append(f"  <!-- {member} -->\n  {body}")
        joined = "\n".join(bodies)
        (out / f"{name}.svg").write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{master_w}" '
            f'height="{master_h}" viewBox="0 0 {master_w} {master_h}">\n'
            f"{shared_defs}\n{joined}\n</svg>\n",
            encoding="utf-8",
        )
        print(f"  composited {name}.svg from {len(members)} layers")

    for group, members in OVERLAYS.items():
        target = out / group
        target.mkdir(parents=True, exist_ok=True)
        src_dir = pack / "assets/svg" / OVERLAY_DIRS[group]
        for src_name, out_name in members.items():
            defs, body = read_parts(src_dir / f"{src_name}.svg")
            (target / f"{out_name}.svg").write_text(
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{overlay_side}" '
                f'height="{overlay_side}" '
                f'viewBox="0 0 {overlay_side} {overlay_side}">\n'
                f"{defs}\n  {body}\n</svg>\n",
                encoding="utf-8",
            )
        print(f"  copied {len(members)} {group} overlays")

    # Flat artwork for the landing hero and the `image` avatar mode.
    shutil.copyfile(pack / "assets/svg/views/full_body_front.svg", out / "still.svg")
    print(f"  wrote still.svg -> {out}")

    write_rig_module(rig, rig_module)


def main() -> None:
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pack", required=True, type=Path,
                    help="unzipped HAICI_Mascot_Animation_Asset_Pack directory")
    ap.add_argument("--out", type=Path, default=repo / "web/public/mascot")
    ap.add_argument("--rig-module", type=Path, default=repo / "web/src/lib/mascotRig.ts")
    args = ap.parse_args()

    if not (args.pack / "source/rig/HAICI_Mascot_Rig.json").exists():
        raise SystemExit(f"{args.pack} does not look like the mascot pack")
    args.out.mkdir(parents=True, exist_ok=True)
    print(f"building mascot assets from {args.pack}")
    build(args.pack, args.out, args.rig_module)


if __name__ == "__main__":
    main()
