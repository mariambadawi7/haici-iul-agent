/**
 * Cut the visitor's face out of the live camera stream, as a JPEG the vision
 * backend can use as a reference photo.
 *
 * WHY TWO SETS OF DIMENSIONS
 *
 * The backend reports every box in "source-frame pixels" and tells you which
 * frame it means in `Snapshot.frame`. That is the frame the backend received —
 * not necessarily the frame this browser is capturing. WebRTC downscales
 * adaptively under bandwidth or CPU pressure, so the publisher can quietly
 * drop from 1280x720 to 640x360 mid-session while the local `<video>` element
 * still decodes at whatever the negotiated resolution now is. Treating the box
 * as if it were already in video pixels then crops the wrong region — usually
 * a corner of the forehead, which enrolls beautifully and matches nothing.
 *
 * So every box is scaled by `videoWidth / frame.w` before it is used. When the
 * two agree that is a multiply by one and costs nothing; when they diverge it
 * is the difference between a usable reference photo and a silent, permanent
 * recognition failure.
 */

/** `[x, y, width, height]`, matching the backend's Box type. */
export type Box = [number, number, number, number];

export interface FrameSize {
  w: number;
  h: number;
}

/**
 * Margin added around the reported box, as a fraction of its size.
 *
 * Not cosmetic. A reference photo is re-detected from scratch when the gallery
 * loads (`FaceMatcher.reload_gallery` runs the YuNet detector over the file and
 * skips it with "No face found in reference image" if nothing is found), and a
 * detector fed a crop cut exactly at the previous detection's edge frequently
 * finds nothing at all. The margin also gives `alignCrop` the landmark room it
 * needs to rotate the face upright.
 */
const PAD = 0.4;

/**
 * Refuse to enroll a face smaller than this, in video pixels.
 *
 * A face 60 pixels across is someone walking past at four metres. It will
 * enroll happily and then match almost anyone, because a low-resolution
 * embedding sits close to the middle of the space. Refusing is much better
 * than a permanent bad reference: the caller simply tries again on a later
 * frame, and the visitor is usually walking towards the kiosk anyway.
 */
const MIN_FACE_PX = 110;

/** JPEG quality. High: this image is re-embedded, not looked at. */
const QUALITY = 0.92;

export interface CropFaceOptions {
  video: HTMLVideoElement;
  /** The nearest person's `face_box`, in source-frame pixels. */
  box: Box;
  /** `Snapshot.frame` — the coordinate system `box` is expressed in. */
  frame: FrameSize;
}

/**
 * Returns a JPEG of the padded face region, or null when this frame cannot
 * produce a usable one. Null is an ordinary outcome, not an error: the caller
 * is sampling a live stream and can simply wait for a better frame.
 */
export async function cropFace({ video, box, frame }: CropFaceOptions): Promise<Blob | null> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  // readyState < HAVE_CURRENT_DATA means there is no decoded frame to draw;
  // drawImage would silently paint nothing and we would enroll a black square.
  if (!vw || !vh || video.readyState < 2) return null;
  if (!frame?.w || !frame?.h) return null;

  const [bx, by, bw, bh] = box;
  if (!(bw > 0 && bh > 0)) return null;

  const scaleX = vw / frame.w;
  const scaleY = vh / frame.h;

  const faceW = bw * scaleX;
  const faceH = bh * scaleY;
  if (Math.min(faceW, faceH) < MIN_FACE_PX) return null;

  const padX = faceW * PAD;
  const padY = faceH * PAD;

  // Clamp to the frame. A face at the edge yields an off-centre crop, which is
  // fine — what matters is that the region is inside the source, or drawImage
  // pads it with transparent black that JPEG then renders as a hard edge.
  const left = Math.max(0, Math.round(bx * scaleX - padX));
  const top = Math.max(0, Math.round(by * scaleY - padY));
  const right = Math.min(vw, Math.round((bx + bw) * scaleX + padX));
  const bottom = Math.min(vh, Math.round((by + bh) * scaleY + padY));

  const width = right - left;
  const height = bottom - top;
  if (width < MIN_FACE_PX || height < MIN_FACE_PX) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // No mirroring. The kiosk may present the camera flipped for a natural
  // selfie view, but that is a CSS transform on the element — the decoded
  // pixels drawImage reads are the true orientation, which is what the
  // recogniser was trained on.
  ctx.drawImage(video, left, top, width, height, 0, 0, width, height);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", QUALITY);
  });
}
