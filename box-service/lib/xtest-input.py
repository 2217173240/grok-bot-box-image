#!/usr/bin/env python3
import json, sys, ctypes
x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
xtst = ctypes.cdll.LoadLibrary("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
x11.XDefaultScreen.restype = ctypes.c_int
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
NOW = 0
PUNCT = {
    " ": "space", "-": "minus", "=": "equal", "[": "bracketleft",
    "]": "bracketright", "\\": "backslash", ";": "semicolon",
    "'": "apostrophe", ",": "comma", ".": "period", "/": "slash",
    "`": "grave", "\n": "Return", "\t": "Tab",
    "!": ("1", True), "@": ("2", True), "#": ("3", True), "$": ("4", True),
    "%": ("5", True), "^": ("6", True), "&": ("7", True), "*": ("8", True),
    "(": ("9", True), ")": ("0", True), "_": ("minus", True),
    "+": ("equal", True), "{": ("bracketleft", True), "}": ("bracketright", True),
    "|": ("backslash", True), ":": ("semicolon", True), '"': ("apostrophe", True),
    "<": ("comma", True), ">": ("period", True), "?": ("slash", True),
    "~": ("grave", True),
}
ALIASES = {
    "enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape",
    "tab": "Tab", "space": "space", "backspace": "BackSpace",
    "delete": "Delete", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
}
def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)
def open_dpy(name):
    dpy = x11.XOpenDisplay(name.encode())
    if not dpy:
        die("cannot open display " + name)
    return dpy
def keycode(dpy, name):
    ks = x11.XStringToKeysym(name.encode())
    if not ks:
        die("unknown key " + name)
    code = x11.XKeysymToKeycode(dpy, ks)
    if not code:
        die("no keycode for " + name)
    return code
def tap_key(dpy, name, shift=False):
    shift_code = keycode(dpy, "Shift_L")
    code = keycode(dpy, name)
    if shift:
        xtst.XTestFakeKeyEvent(dpy, shift_code, True, NOW)
    xtst.XTestFakeKeyEvent(dpy, code, True, NOW)
    xtst.XTestFakeKeyEvent(dpy, code, False, NOW)
    if shift:
        xtst.XTestFakeKeyEvent(dpy, shift_code, False, NOW)
def move(dpy, screen, x, y):
    xtst.XTestFakeMotionEvent(dpy, screen, int(x), int(y), NOW)
def tap_btn(dpy, button):
    xtst.XTestFakeButtonEvent(dpy, button, True, NOW)
    xtst.XTestFakeButtonEvent(dpy, button, False, NOW)
def type_text(dpy, text):
    for ch in text:
        if "a" <= ch <= "z" or "0" <= ch <= "9":
            tap_key(dpy, ch); continue
        if "A" <= ch <= "Z":
            tap_key(dpy, ch.lower(), shift=True); continue
        spec = PUNCT.get(ch)
        if spec is None:
            die("unsupported char")
        if isinstance(spec, tuple):
            tap_key(dpy, spec[0], shift=spec[1])
        else:
            tap_key(dpy, spec)
def main():
    if len(sys.argv) != 2:
        die("usage")
    body = json.load(sys.stdin)
    action = body.get("action")
    dpy = open_dpy(sys.argv[1])
    screen = x11.XDefaultScreen(dpy)
    try:
        if action == "click":
            move(dpy, screen, body["x"], body["y"]); tap_btn(dpy, 1)
        elif action == "scroll":
            move(dpy, screen, body["x"], body["y"])
            tap_btn(dpy, 4 if body.get("dir") == "up" else 5)
        elif action == "type":
            if body.get("x") is not None and body.get("y") is not None:
                move(dpy, screen, body["x"], body["y"]); tap_btn(dpy, 1)
            type_text(dpy, body["text"])
        elif action == "key":
            if body.get("x") is not None and body.get("y") is not None:
                move(dpy, screen, body["x"], body["y"]); tap_btn(dpy, 1)
            raw = str(body["key"])
            name = ALIASES.get(raw.lower(), raw if len(raw) > 1 else raw)
            if len(name) == 1 and "A" <= name <= "Z":
                tap_key(dpy, name.lower(), shift=True)
            elif len(name) == 1 and "a" <= name <= "z":
                tap_key(dpy, name)
            else:
                tap_key(dpy, name)
        else:
            die("unknown action")
        x11.XSync(dpy, False)
        x11.XFlush(dpy)
    finally:
        x11.XCloseDisplay(dpy)
if __name__ == "__main__":
    main()
