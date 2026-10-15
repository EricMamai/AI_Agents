#!/usr/bin/env python3
"""HM Vintage Leather: local storefront with M-Pesa (Safaricom Daraja STK Push) checkout.

    python server.py        then open http://localhost:3000

Standard library only. M-Pesa runs in simulation mode until Daraja credentials
are added to .env (see .env.example).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
WEB = (ROOT / "web").resolve()
DATA = ROOT / "data"


def load_env(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.split(" #", 1)[0].strip().strip("\"'"))


load_env(ROOT / ".env")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


# ---------------------------------------------------------------- configuration

HOST = env("HOST", "127.0.0.1")
PORT = int(env("PORT", "3000"))

MPESA_ENV = "production" if env("MPESA_ENV", "sandbox").lower() == "production" else "sandbox"
MPESA_KEY = env("MPESA_CONSUMER_KEY")
MPESA_SECRET = env("MPESA_CONSUMER_SECRET")
MPESA_SHORTCODE = env("MPESA_SHORTCODE")
MPESA_PASSKEY = env("MPESA_PASSKEY")
MPESA_TXN_TYPE = env("MPESA_TRANSACTION_TYPE", "CustomerPayBillOnline")
MPESA_PARTY_B = env("MPESA_PARTY_B") or MPESA_SHORTCODE
CALLBACK_BASE = env("MPESA_CALLBACK_BASE_URL").rstrip("/")

LIVE = all([MPESA_KEY, MPESA_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY]) and CALLBACK_BASE.startswith("https://")
MODE = MPESA_ENV if LIVE else "simulate"
# Unguessable path segment so only Safaricom (who is given the URL) can post callbacks.
CALLBACK_SECRET = hmac.new(MPESA_SECRET.encode(), b"hm-mpesa-callback", hashlib.sha256).hexdigest()[:32]

SIZES = [40, 41, 42, 43, 44, 45]
HOLD_SECONDS = 10 * 60          # stock held for a pending M-Pesa payment
MAX_QTY_PER_LINE = 3
MAX_BODY_BYTES = 32 * 1024
ORDER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}", f"[::1]:{PORT}"}
if CALLBACK_BASE:
    ALLOWED_HOSTS.add(urlparse(CALLBACK_BASE).netloc.lower())
ALLOWED_HOSTS.update(h.strip().lower() for h in env("ALLOWED_HOSTS").split(",") if h.strip())

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; "
        "connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

PAGES = {"/": "index.html", "/shop": "shop.html", "/product": "product.html", "/checkout": "checkout.html", "/order": "order.html"}
MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
}


def default_db_path() -> Path:
    # Kept outside the project so cloud-synced folders (OneDrive, Dropbox) cannot lock the database.
    if env("HM_DB_PATH"):
        return Path(env("HM_DB_PATH"))
    base = env("LOCALAPPDATA") or env("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "hm-vintage-shoes" / "orders.sqlite3"


DB_PATH = default_db_path()
SSL_CONTEXT = ssl.create_default_context()

RESULT_MESSAGES = {
    1: "Your M-Pesa balance is too low for this payment. Top up and try again.",
    1019: "The M-Pesa request expired. Please try again.",
    1032: "The payment request was cancelled on your phone.",
    1037: "The M-Pesa prompt timed out. Make sure your phone is on and try again.",
    2001: "The M-Pesa PIN entered was incorrect.",
}
GENERIC_FAILURE = "M-Pesa could not complete the payment. No money was taken."
SIM_OUTCOMES = {"success": 0, "cancelled": 1032, "insufficient": 1, "wrong_pin": 2001, "timeout": 1037}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class DarajaError(Exception):
    def __init__(self, public_message: str, detail: str = ""):
        super().__init__(detail or public_message)
        self.public_message = public_message


def log(message: str) -> None:
    sys.stderr.write(f"[hm] {message}\n")


# ------------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  mpesa_phone TEXT NOT NULL,
  county TEXT NOT NULL,
  town TEXT NOT NULL,
  address TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL,
  total INTEGER NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  merchant_request_id TEXT,
  checkout_request_id TEXT UNIQUE,
  receipt TEXT,
  result_code INTEGER,
  result_desc TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  last_query_at REAL
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  colour TEXT NOT NULL,
  image TEXT NOT NULL,
  size INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id, size);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ------------------------------------------------------------------ catalogue

def read_json(name: str) -> dict:
    with (DATA / name).open(encoding="utf-8") as fh:
        return json.load(fh)


def zone_for(county: str, delivery: dict) -> dict:
    zones = {z["id"]: z for z in delivery["zones"]}
    if county == "Nairobi":
        return zones["nairobi"]
    return zones["metro"] if county in delivery["metro"] else zones["country"]


def held_quantities(conn: sqlite3.Connection) -> dict[tuple[str, int], int]:
    rows = conn.execute(
        """SELECT i.product_id, i.size, SUM(i.qty) AS qty
           FROM order_items i JOIN orders o ON o.id = i.order_id
           WHERE o.status = 'paid' OR (o.status = 'pending' AND o.created_at > ?)
           GROUP BY i.product_id, i.size""",
        (time.time() - HOLD_SECONDS,),
    ).fetchall()
    return {(r["product_id"], r["size"]): r["qty"] for r in rows}


def public_products(conn: sqlite3.Connection) -> dict:
    catalogue = read_json("products.json")
    held = held_quantities(conn)
    for product in catalogue["products"]:
        stock = product.pop("stock", {})
        product["sizes"] = [
            {"size": s, "available": max(0, int(stock.get(str(s), 0)) - held.get((product["id"], s), 0))} for s in SIZES
        ]
    return catalogue


def public_config() -> dict:
    delivery = read_json("delivery.json")
    return {
        "mode": MODE,
        "currency": "KES",
        "sizes": SIZES,
        "zones": delivery["zones"],
        "counties": [{"name": c, "zone": zone_for(c, delivery)["id"]} for c in delivery["counties"]],
    }


# ----------------------------------------------------------------- validation

def normalize_phone(raw: object) -> str | None:
    digits = re.sub(r"[\s\-().]", "", str(raw or ""))
    match = re.fullmatch(r"(?:\+?254|0)?([17]\d{8})", digits)
    return "254" + match.group(1) if match else None


def mask_phone(msisdn: str) -> str:
    return f"0{msisdn[3:6]} *** {msisdn[-3:]}"


def clean_text(value: object, label: str, min_len: int, max_len: int, required: bool = True) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text and not required:
        return ""
    if not min_len <= len(text) <= max_len:
        raise ApiError(400, f"{label} must be between {min_len} and {max_len} characters.")
    return text


_hits: dict[str, list[float]] = {}
_hits_lock = threading.Lock()


def rate_limited(key: str, limit: int, window: int) -> bool:
    now = time.time()
    with _hits_lock:
        recent = [t for t in _hits.get(key, []) if now - t < window]
        blocked = len(recent) >= limit
        if not blocked:
            recent.append(now)
        _hits[key] = recent
        return blocked


# --------------------------------------------------------------------- Daraja

def daraja_url(path: str) -> str:
    host = "api.safaricom.co.ke" if MPESA_ENV == "production" else "sandbox.safaricom.co.ke"
    return f"https://{host}{path}"


def http_json(url: str, *, method: str = "GET", headers: dict | None = None, body: dict | None = None, timeout: int = 20) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        hint = " (Python could not verify Safaricom's TLS certificate; point SSL_CERT_FILE at a CA bundle)" if isinstance(reason, ssl.SSLCertVerificationError) else ""
        raise DarajaError("We could not reach M-Pesa right now. Please try again in a moment.", f"network error: {reason}{hint}") from exc
    try:
        return status, json.loads(raw or b"{}")
    except ValueError:
        return status, {}


_token = {"value": "", "expires": 0.0}
_token_lock = threading.Lock()


def access_token(force: bool = False) -> str:
    with _token_lock:
        if _token["value"] and not force and time.time() < _token["expires"]:
            return _token["value"]
        basic = base64.b64encode(f"{MPESA_KEY}:{MPESA_SECRET}".encode()).decode()
        status, body = http_json(daraja_url("/oauth/v1/generate?grant_type=client_credentials"), headers={"Authorization": f"Basic {basic}"})
        if status != 200 or not body.get("access_token"):
            raise DarajaError("M-Pesa is not available right now. Please try again shortly.", f"OAuth failed: HTTP {status} {body} (check MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET and MPESA_ENV)")
        _token.update(value=body["access_token"], expires=time.time() + int(body.get("expires_in", 3599)) - 60)
        return _token["value"]


def daraja_post(path: str, payload: dict) -> tuple[int, dict]:
    for attempt in (0, 1):
        status, body = http_json(daraja_url(path), method="POST", headers={"Authorization": f"Bearer {access_token(force=attempt == 1)}"}, body=payload)
        if status != 401:
            break
    return status, body


def stk_credentials() -> tuple[str, str]:
    timestamp = datetime.now(timezone(timedelta(hours=3))).strftime("%Y%m%d%H%M%S")  # East Africa Time
    password = base64.b64encode(f"{MPESA_SHORTCODE}{MPESA_PASSKEY}{timestamp}".encode()).decode()
    return timestamp, password


def stk_push(order_number: str, msisdn: str, amount: int) -> dict:
    timestamp, password = stk_credentials()
    status, body = daraja_post("/mpesa/stkpush/v1/processrequest", {
        "BusinessShortCode": MPESA_SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": MPESA_TXN_TYPE,
        "Amount": amount,
        "PartyA": msisdn,
        "PartyB": MPESA_PARTY_B,
        "PhoneNumber": msisdn,
        "CallBackURL": f"{CALLBACK_BASE}/api/mpesa/callback/{CALLBACK_SECRET}",
        "AccountReference": order_number[:12],
        "TransactionDesc": "HM Shoes",
    })
    if status == 200 and str(body.get("ResponseCode")) == "0" and body.get("CheckoutRequestID"):
        return body
    error_code = str(body.get("errorCode", ""))
    if error_code == "500.001.1001":
        message = "You already have an M-Pesa prompt waiting on your phone. Approve or dismiss it, wait about 30 seconds, then try again."
    elif error_code == "400.002.02":
        message = "M-Pesa rejected that phone number. Check it and try again."
    else:
        message = "M-Pesa could not start the payment. Please try again."
    raise DarajaError(message, f"STK push failed: HTTP {status} {body}")


def stk_query(checkout_request_id: str) -> tuple[int, str] | None:
    timestamp, password = stk_credentials()
    _, body = daraja_post("/mpesa/stkpushquery/v1/query", {
        "BusinessShortCode": MPESA_SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "CheckoutRequestID": checkout_request_id,
    })
    try:
        return int(body["ResultCode"]), str(body.get("ResultDesc", ""))
    except (KeyError, TypeError, ValueError):
        return None  # still processing (Daraja answers 500.001.1001 until the customer responds)


# --------------------------------------------------------------------- orders

_order_lock = threading.Lock()


def new_order_number() -> str:
    return "HM-" + "".join(secrets.choice(ORDER_ALPHABET) for _ in range(6))


def create_order(body: object, client_ip: str) -> dict:
    if not isinstance(body, dict):
        raise ApiError(400, "Invalid request.")
    customer = body.get("customer") if isinstance(body.get("customer"), dict) else {}
    place = body.get("delivery") if isinstance(body.get("delivery"), dict) else {}

    name = clean_text(customer.get("name"), "Name", 2, 80)
    phone = normalize_phone(customer.get("phone"))
    mpesa_phone = normalize_phone(body.get("mpesaPhone") or customer.get("phone"))
    if not phone or not mpesa_phone:
        raise ApiError(400, "Enter a valid Kenyan phone number, for example 0712 345 678.")
    county = clean_text(place.get("county"), "County", 3, 30)
    town = clean_text(place.get("town"), "Town or area", 2, 60)
    address = clean_text(place.get("address"), "Delivery address", 5, 160)
    notes = clean_text(place.get("notes"), "Notes", 0, 200, required=False)

    delivery = read_json("delivery.json")
    if county not in delivery["counties"]:
        raise ApiError(400, "Choose a county in Kenya.")

    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not 1 <= len(raw_items) <= 10:
        raise ApiError(400, "Your bag is empty.")
    catalogue = {p["id"]: p for p in read_json("products.json")["products"]}
    wanted: dict[tuple[str, int], int] = {}
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ApiError(400, "Invalid item in your bag.")
        product_id, size, qty = raw.get("id"), raw.get("size"), raw.get("qty")
        valid = (
            product_id in catalogue
            and isinstance(size, int) and not isinstance(size, bool) and size in SIZES
            and isinstance(qty, int) and not isinstance(qty, bool) and 1 <= qty <= MAX_QTY_PER_LINE
        )
        if not valid:
            raise ApiError(400, "An item in your bag is no longer valid. Please review your bag.")
        wanted[(product_id, size)] = wanted.get((product_id, size), 0) + qty
    if any(q > MAX_QTY_PER_LINE for q in wanted.values()):
        raise ApiError(400, f"You can order up to {MAX_QTY_PER_LINE} pairs of the same size.")

    # Limits protect real phones from prompt spam; they only matter when real STK pushes are sent.
    ip_limit, phone_limit = (10, 4) if LIVE else (100, 100)
    if rate_limited(f"ip:{client_ip}", ip_limit, 600) or rate_limited(f"msisdn:{mpesa_phone}", phone_limit, 600):
        raise ApiError(429, "Too many payment attempts. Please wait a few minutes and try again.")

    subtotal = sum(catalogue[pid]["price"] * qty for (pid, _), qty in wanted.items())
    fee = zone_for(county, delivery)["fee"]
    total = subtotal + fee
    token = secrets.token_urlsafe(16)
    now = time.time()

    with _order_lock, db() as conn:
        # A retry from the same phone replaces its earlier unpaid attempt, releasing that stock hold.
        conn.execute("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE status = 'pending' AND mpesa_phone = ?", (now, mpesa_phone))
        held = held_quantities(conn)
        for (pid, size), qty in wanted.items():
            available = int(catalogue[pid].get("stock", {}).get(str(size), 0)) - held.get((pid, size), 0)
            if qty > available:
                raise ApiError(409, f"Sorry, {catalogue[pid]['name']} in EU {size} was just taken. Please choose another size.")
        for _ in range(5):
            number = new_order_number()
            try:
                cursor = conn.execute(
                    """INSERT INTO orders (token, number, status, customer_name, phone, mpesa_phone, county, town, address, notes,
                                           subtotal, delivery_fee, total, simulated, created_at, updated_at)
                       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (token, number, name, phone, mpesa_phone, county, town, address, notes, subtotal, fee, total, 0 if LIVE else 1, now, now),
                )
                break
            except sqlite3.IntegrityError:
                continue
        else:
            raise ApiError(500, "Could not create your order. Please try again.")
        order_id = cursor.lastrowid
        conn.executemany(
            "INSERT INTO order_items (order_id, product_id, name, colour, image, size, qty, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (order_id, pid, catalogue[pid]["name"], catalogue[pid]["colour"], catalogue[pid]["images"][0]["photo"], size, qty, catalogue[pid]["price"])
                for (pid, size), qty in wanted.items()
            ],
        )

    if LIVE:
        try:
            result = stk_push(number, mpesa_phone, total)
        except DarajaError as exc:
            log(f"{number}: {exc}")
            with db() as conn:
                conn.execute("UPDATE orders SET status = 'failed', result_desc = ?, updated_at = ? WHERE id = ?", (exc.public_message, time.time(), order_id))
            raise ApiError(502, exc.public_message) from exc
        with db() as conn:
            conn.execute(
                "UPDATE orders SET merchant_request_id = ?, checkout_request_id = ?, updated_at = ? WHERE id = ?",
                (result.get("MerchantRequestID"), result["CheckoutRequestID"], time.time(), order_id),
            )
    return {"token": token, "number": number, "status": "pending", "total": total, "mode": MODE, "mpesaPhone": mask_phone(mpesa_phone)}


def get_order_row(conn: sqlite3.Connection, token: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM orders WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise ApiError(404, "We could not find that order.")
    return row


def apply_result(conn: sqlite3.Connection, row: sqlite3.Row, code: int, desc: str, receipt: object = None, amount: object = None) -> None:
    """Idempotent: safe to call for duplicate callbacks and for polling races."""
    now = time.time()
    if code == 0:
        try:
            if amount is not None and int(round(float(amount))) != row["total"]:
                log(f"{row['number']}: callback amount {amount} does not match order total {row['total']}; ignored")
                return
        except (TypeError, ValueError):
            return
        conn.execute(
            "UPDATE orders SET status = 'paid', result_code = 0, result_desc = ?, receipt = ?, updated_at = ? WHERE id = ? AND status != 'paid'",
            (desc[:200], str(receipt)[:20] if receipt else None, now, row["id"]),
        )
    else:
        conn.execute(
            "UPDATE orders SET status = 'failed', result_code = ?, result_desc = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
            (code, desc[:200], now, row["id"]),
        )


def refresh_order(conn: sqlite3.Connection, row: sqlite3.Row) -> sqlite3.Row:
    if row["status"] != "pending":
        return row
    now = time.time()
    if LIVE and row["checkout_request_id"] and now - (row["last_query_at"] or 0) > 5 and now - row["created_at"] > 6:
        conn.execute("UPDATE orders SET last_query_at = ? WHERE id = ?", (now, row["id"]))
        conn.commit()
        try:
            result = stk_query(row["checkout_request_id"])
        except DarajaError as exc:
            log(f"{row['number']}: status query failed: {exc}")
            result = None
        if result is not None:
            apply_result(conn, row, result[0], result[1])
            conn.commit()
            row = get_order_row(conn, row["token"])
    if row["status"] == "pending" and now - row["created_at"] > HOLD_SECONDS:
        conn.execute("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'", (now, row["id"]))
        conn.commit()
        row = get_order_row(conn, row["token"])
    return row


def order_view(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    items = conn.execute("SELECT * FROM order_items WHERE order_id = ?", (row["id"],)).fetchall()
    message = None
    if row["status"] == "failed":
        message = RESULT_MESSAGES.get(row["result_code"], GENERIC_FAILURE)
    elif row["status"] == "expired":
        message = "This payment request expired before M-Pesa confirmed it."
    elif row["status"] == "cancelled":
        message = "This order was replaced by a newer payment attempt."
    return {
        "number": row["number"],
        "token": row["token"],
        "status": row["status"],
        "message": message,
        "resultCode": row["result_code"],
        "receipt": row["receipt"],
        "simulated": bool(row["simulated"]),
        "mode": MODE,
        "customerName": row["customer_name"],
        "mpesaPhone": mask_phone(row["mpesa_phone"]),
        "county": row["county"],
        "town": row["town"],
        "address": row["address"],
        "subtotal": row["subtotal"],
        "deliveryFee": row["delivery_fee"],
        "total": row["total"],
        "createdAt": row["created_at"],
        "items": [
            {"id": i["product_id"], "name": i["name"], "colour": i["colour"], "image": i["image"], "size": i["size"], "qty": i["qty"], "price": i["unit_price"]}
            for i in items
        ],
    }


def load_order_view(token: str) -> dict:
    with db() as conn:
        row = refresh_order(conn, get_order_row(conn, token))
        return order_view(conn, row)


def simulate_outcome(token: str, body: object) -> dict:
    if LIVE:
        raise ApiError(404, "Not found.")
    outcome = body.get("outcome") if isinstance(body, dict) else None
    if outcome not in SIM_OUTCOMES:
        raise ApiError(400, "Unknown outcome.")
    code = SIM_OUTCOMES[outcome]
    with db() as conn:
        row = get_order_row(conn, token)
        if row["status"] == "pending":
            receipt = "SIM" + "".join(secrets.choice(ORDER_ALPHABET) for _ in range(7)) if code == 0 else None
            apply_result(conn, row, code, f"Simulated outcome: {outcome}", receipt, row["total"])
        return order_view(conn, get_order_row(conn, token))


def handle_callback(secret: str, body: object) -> None:
    if not LIVE or not hmac.compare_digest(secret, CALLBACK_SECRET):
        raise ApiError(404, "Not found.")
    try:
        callback = body["Body"]["stkCallback"]  # type: ignore[index]
        checkout_id = str(callback["CheckoutRequestID"])
        code = int(callback["ResultCode"])
    except (KeyError, TypeError, ValueError):
        raise ApiError(400, "Malformed callback.")
    metadata = {
        item.get("Name"): item.get("Value")
        for item in (callback.get("CallbackMetadata") or {}).get("Item", [])
        if isinstance(item, dict)
    }
    with db() as conn:
        row = conn.execute("SELECT * FROM orders WHERE checkout_request_id = ?", (checkout_id,)).fetchone()
        if row is None:
            log("callback for an unknown CheckoutRequestID ignored")
            return
        apply_result(conn, row, code, str(callback.get("ResultDesc", "")), metadata.get("MpesaReceiptNumber"), metadata.get("Amount"))


# ----------------------------------------------------------------------- HTTP

def render_page(name: str) -> bytes:
    html = (WEB / name).read_text(encoding="utf-8")
    for key in ("header", "footer"):
        html = html.replace(f"<!--@{key}-->", (WEB / "partials" / f"{key}.html").read_text(encoding="utf-8"))
    return html.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "HMStore/1.0"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        line = re.sub(r"(/api/orders/)[\w-]+", r"\1<token>", fmt % args)
        line = re.sub(r"(/api/mpesa/callback/)[\w-]+", r"\1<secret>", line)
        sys.stderr.write(f"[{self.log_date_time_string()}] {line}\n")

    # -- responses
    def send_bytes(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in {**SECURITY_HEADERS, **(extra or {})}.items():
            self.send_header(key, value)
        if status >= 400:
            self.send_header("Connection", "close")  # request body may be unread
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload: object) -> None:
        self.send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json", {"Cache-Control": "no-store"})

    def send_not_found(self) -> None:
        self.send_bytes(404, b"<!doctype html><meta charset=utf-8><title>Not found</title><h1>Page not found</h1><p><a href=/>Back to HM</a></p>", MIME[".html"])

    # -- request handling
    def do_GET(self) -> None:
        self.dispatch(self.route_get)

    def do_POST(self) -> None:
        self.dispatch(self.route_post)

    def dispatch(self, route) -> None:
        try:
            host = (self.headers.get("Host") or "").lower()
            origin = self.headers.get("Origin")
            if host not in ALLOWED_HOSTS:
                raise ApiError(400, "Unrecognised host.")
            if origin and self.command == "POST" and urlparse(origin).netloc.lower() not in ALLOWED_HOSTS:
                raise ApiError(403, "Cross-origin requests are not allowed.")
            route(urlparse(self.path).path)
        except ApiError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Something went wrong on our side. Please try again."})

    def read_json(self) -> object:
        if self.headers.get_content_type() != "application/json":
            raise ApiError(415, "Send JSON.")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Invalid request.")
        if not 0 < length <= MAX_BODY_BYTES:
            raise ApiError(413, "Request too large.")
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            raise ApiError(400, "Invalid JSON.")

    def route_get(self, path: str) -> None:
        if path == "/api/config":
            return self.send_json(200, public_config())
        if path == "/api/products":
            with db() as conn:
                return self.send_json(200, public_products(conn))
        match = re.fullmatch(r"/api/orders/([\w-]{10,64})", path)
        if match:
            return self.send_json(200, load_order_view(match.group(1)))
        if path.startswith("/api/"):
            raise ApiError(404, "Not found.")
        self.serve_web(path)

    def route_post(self, path: str) -> None:
        body = self.read_json()
        if path == "/api/orders":
            return self.send_json(201, create_order(body, self.client_address[0]))
        match = re.fullmatch(r"/api/orders/([\w-]{10,64})/simulate", path)
        if match:
            return self.send_json(200, simulate_outcome(match.group(1), body))
        match = re.fullmatch(r"/api/mpesa/callback/([\w-]+)", path)
        if match:
            handle_callback(match.group(1), body)
            return self.send_json(200, {"ResultCode": 0, "ResultDesc": "Accepted"})
        raise ApiError(404, "Not found.")

    def serve_web(self, path: str) -> None:
        if path in PAGES:
            return self.send_bytes(200, render_page(PAGES[path]), MIME[".html"], {"Cache-Control": "no-cache"})
        if path == "/favicon.ico":
            path = "/img/logo.svg"
        try:
            target = (WEB / unquote(path).lstrip("/")).resolve()
            parts = target.relative_to(WEB).parts
        except (ValueError, OSError):
            return self.send_not_found()
        suffix = target.suffix.lower()
        if not target.is_file() or suffix not in MIME or suffix == ".html" or "partials" in parts or any(p.startswith(".") for p in parts):
            return self.send_not_found()
        cache = "public, max-age=604800" if parts[0] in ("img", "fonts") else "no-cache"
        self.send_bytes(200, target.read_bytes(), MIME[suffix], {"Cache-Control": cache})


def main() -> None:
    init_db()
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        sys.exit(f"Could not start on {HOST}:{PORT} ({exc}). Set a different PORT in .env.")
    label = {"simulate": "SIMULATION (no real M-Pesa requests)", "sandbox": "Daraja SANDBOX", "production": "Daraja PRODUCTION (real money)"}[MODE]
    print(f"\n  HM Vintage Leather is running\n    Local:   http://localhost:{PORT}\n    M-Pesa:  {label}\n    Orders:  {DB_PATH}\n    Stop:    Ctrl+C\n", flush=True)
    if not LIVE and any([MPESA_KEY, MPESA_SECRET, MPESA_PASSKEY]):
        print("  Note: Daraja settings in .env are incomplete (need key, secret, shortcode, passkey and an https MPESA_CALLBACK_BASE_URL).\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
