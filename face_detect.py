"""
HAICI AI Receptionist — Face Detection Trigger
================================================
Uses OpenCV's built-in face detector (no MediaPipe needed).
When a face is detected after an idle period, sends
{"type": "presence_detected"} to the WebSocket relay.

Usage:
    python face_detect.py
"""

import cv2
import websocket
import json
import threading
import time
import sys
import os

# ── CONFIG ──────────────────────────────────────────────────────────
WS_URL          = "ws://localhost:3001/ws?client=hardware"
IDLE_TIMEOUT_S  = 180       # seconds before re-triggering
CAMERA_INDEX    = 0        # 0 = default laptop webcam
SHOW_PREVIEW    = True     # set False to run headless
SCALE_FACTOR    = 1.1      # face detector sensitivity
MIN_NEIGHBORS   = 7        # higher = fewer false positives
# ────────────────────────────────────────────────────────────────────

# State
ws_conn        = None
ws_connected   = False
last_trigger_t = 0
face_present   = False

# ── WebSocket ────────────────────────────────────────────────────────
def on_open(ws):
    global ws_connected
    ws_connected = True
    print("[ws] Connected to relay at", WS_URL)

def on_close(ws, code, msg):
    global ws_connected
    ws_connected = False
    print("[ws] Disconnected — will retry in 5s")

def on_error(ws, err):
    print("[ws] Error:", err)

def on_message(ws, msg):
    try:
        data = json.loads(msg)
        print("[ws] Received:", data)
    except Exception:
        pass

def connect_ws():
    global ws_conn
    while True:
        try:
            ws_conn = websocket.WebSocketApp(
                WS_URL,
                on_open=on_open,
                on_close=on_close,
                on_error=on_error,
                on_message=on_message,
            )
            ws_conn.run_forever()
        except Exception as e:
            print("[ws] Connection failed:", e)
        time.sleep(5)

def send_presence():
    global ws_conn, ws_connected
    if ws_connected and ws_conn:
        try:
            ws_conn.send(json.dumps({"type": "presence_detected"}))
            print("[face] SUCCESS: presence_detected sent to relay!")
        except Exception as e:
            print("[face] Failed to send:", e)
    else:
        print("[face] WARNING: Not connected to relay")

# ── Face Detection ───────────────────────────────────────────────────
def run_detection():
    global last_trigger_t, face_present

    # Load OpenCV's built-in face detector. Prefer the copy that ships inside
    # the installed opencv-python package, and fall back to the one committed
    # next to this script. A hardcoded absolute path only works on the one
    # machine it was written on, and CascadeClassifier fails SILENTLY on a
    # missing file (returns an empty classifier instead of raising) — the
    # error only surfaces later, as an opaque assertion failure inside
    # detectMultiScale, well after "Camera opened" has already printed.
    cascade_candidates = [
        os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "haarcascade_frontalface_default.xml"),
    ]
    cascade_path = next((p for p in cascade_candidates if os.path.exists(p)), None)
    if cascade_path is None:
        sys.exit(f"[face] No Haar cascade found. Looked in: {cascade_candidates}")

    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        sys.exit(f"[face] Cascade at {cascade_path} failed to load.")
    print(f"[face] Using cascade: {cascade_path}")

    cap = cv2.VideoCapture(CAMERA_INDEX)
    if not cap.isOpened():
        print(f"[camera] Cannot open camera index {CAMERA_INDEX}")
        sys.exit(1)

    print(f"[camera] Camera opened (index {CAMERA_INDEX})")
    print("[face] Watching for faces... Press Q to quit")

    while True:
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.1)
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=SCALE_FACTOR,
            minNeighbors=MIN_NEIGHBORS,
            minSize=(80, 80)
        )

        now = time.time()
        detected = len(faces) > 0

        if detected:
            if not face_present:
                idle_s = now - last_trigger_t
                if idle_s >= IDLE_TIMEOUT_S:
                    print(f"[face] Face detected after {idle_s:.0f}s idle -> triggering!")
                    last_trigger_t = now
                    send_presence()
                else:
                    remaining = IDLE_TIMEOUT_S - idle_s
                    print(f"[face] Face detected (cooldown: {remaining:.0f}s left)")
            face_present = True
        else:
            if face_present:
                print("[face] Face left frame")
            face_present = False

        if SHOW_PREVIEW:
            display = frame.copy()

            # Draw face rectangles
            for (x, y, w, h) in faces:
                cv2.rectangle(display, (x, y), (x+w, y+h), (0, 200, 0), 2)

            # Status bar
            status_color = (0, 200, 0) if detected else (0, 0, 200)
            status_text  = f"FACE DETECTED ({len(faces)})" if detected else "NO FACE"
            ws_text      = "WS: CONNECTED" if ws_connected else "WS: DISCONNECTED"

            cv2.rectangle(display, (0, 0), (320, 65), (20, 20, 20), -1)
            cv2.putText(display, status_text, (10, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.75, status_color, 2)
            cv2.putText(display, ws_text, (10, 52),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                        (0, 200, 0) if ws_connected else (0, 80, 200), 1)

            cv2.imshow("HAICI Face Detection — Press Q to quit", display)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                print("[face] Quitting...")
                break

    cap.release()
    if SHOW_PREVIEW:
        cv2.destroyAllWindows()

# ── Main ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 50)
    print("  HAICI AI Receptionist — Face Detection")
    print("=" * 50)
    print(f"  WebSocket    : {WS_URL}")
    print(f"  Idle timeout : {IDLE_TIMEOUT_S}s")
    print(f"  Camera index : {CAMERA_INDEX}")
    print("=" * 50)

    # Start WebSocket in background thread
    ws_thread = threading.Thread(target=connect_ws, daemon=True)
    ws_thread.start()
    time.sleep(2)

    # Start face detection
    run_detection()