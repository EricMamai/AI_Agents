# HM Vintage Leather

A responsive e-commerce storefront for selling vintage Italian leather shoes across Kenya. Customers can browse the collection, choose a size, manage a shopping bag, calculate delivery costs, and complete checkout with Safaricom M-Pesa.

The application is intentionally lightweight: the frontend uses HTML, CSS, and vanilla JavaScript, while the backend runs entirely on Python's standard library. No package installation or build step is required.

## Table of contents

- [About the project](#about-the-project)
- [Features](#features)
- [Technology](#technology)
- [Getting started](#getting-started)
- [M-Pesa modes](#m-pesa-modes)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [API overview](#api-overview)
- [Data and persistence](#data-and-persistence)
- [Development notes](#development-notes)

## About the project

HM Vintage Leather is a complete shopping experience designed for the Kenyan market. Product prices are shown in Kenyan shillings, delivery is available across all counties, and M-Pesa Express (STK Push) is the supported payment method.

The storefront can be explored safely without payment credentials. By default, it runs in simulation mode, where developers can test successful, cancelled, timed-out, insufficient-balance, and incorrect-PIN payment outcomes without sending an M-Pesa request or moving money.

## Features

### For shoppers

- Browse a curated catalogue of vintage Italian leather shoes.
- Filter products by colour, style, condition, and size.
- Sort the collection by featured products or price.
- View product photos, details, availability, and related items.
- Add products to a persistent shopping bag.
- Calculate delivery fees for every Kenyan county.
- Check out using a Kenyan mobile number and M-Pesa.
- Follow payment and order status from a dedicated order page.
- Use the storefront across desktop and mobile screen sizes.

### For developers

- Zero third-party runtime dependencies.
- Safe M-Pesa simulation mode for local development.
- Safaricom Daraja sandbox and production support.
- SQLite order persistence with automatic schema creation.
- Server-side stock validation and temporary stock holds.
- JSON-based catalogue and delivery configuration.
- Host and origin validation, request-size limits, and security headers.
- Responsive images, local fonts, and accessible interface elements.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | HTML5, CSS3, vanilla JavaScript ES modules |
| Backend | Python 3.10+ standard library |
| Database | SQLite |
| Payments | Safaricom Daraja M-Pesa Express |
| Product data | JSON |
| Local storage | Browser `localStorage` for the shopping bag |

## Getting started

### Prerequisites

- [Python 3.10 or newer](https://www.python.org/downloads/)
- A modern web browser
- Optional: Safaricom Daraja credentials for sandbox or production payments

### Run locally

1. Clone the repository:

   ```bash
   git clone https://github.com/EricMamai/AI_Agents.git
   cd AI_Agents/hm-vintage-shoes
   ```

2. Create a local environment file:

   **Windows PowerShell**

   ```powershell
   Copy-Item .env.example .env
   ```

   **macOS or Linux**

   ```bash
   cp .env.example .env
   ```

   All settings are optional for local development. Leaving the M-Pesa credentials empty enables simulation mode.

3. Start the server:

   ```bash
   python server.py
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

5. Stop the server with <kbd>Ctrl</kbd> + <kbd>C</kbd>.

VS Code users can also run the **HM: start storefront (http://localhost:3000)** task.

## M-Pesa modes

The server selects its payment mode from the available configuration:

| Mode | When it is used | Money movement |
| --- | --- | --- |
| Simulation | Daraja credentials are missing or incomplete | None |
| Sandbox | Complete sandbox credentials and an HTTPS callback URL are provided | Safaricom test environment only |
| Production | Complete production credentials, `MPESA_ENV=production`, and an HTTPS callback URL are provided | Real payments |

In simulation mode, checkout displays controls for selecting a payment outcome. This makes the complete order flow testable without external services.

> [!CAUTION]
> Production mode can initiate real M-Pesa transactions. Verify the shortcode, passkey, transaction type, callback URL, and environment before enabling it.

## Configuration

Copy `hm-vintage-shoes/.env.example` to `hm-vintage-shoes/.env`, then update only the values you need. Never commit the resulting `.env` file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address on which the server listens |
| `PORT` | `3000` | Local server port |
| `ALLOWED_HOSTS` | Empty | Additional comma-separated `Host` headers to accept |
| `HM_DB_PATH` | Platform-specific user data directory | Optional custom path for the SQLite database |
| `MPESA_ENV` | `sandbox` | Daraja environment: `sandbox` or `production` |
| `MPESA_CONSUMER_KEY` | Empty | Daraja application consumer key |
| `MPESA_CONSUMER_SECRET` | Empty | Daraja application consumer secret |
| `MPESA_SHORTCODE` | `174379` in the example file | Paybill or store number |
| `MPESA_PASSKEY` | Empty | M-Pesa Express passkey |
| `MPESA_TRANSACTION_TYPE` | `CustomerPayBillOnline` | Paybill or Buy Goods transaction type |
| `MPESA_PARTY_B` | Uses the shortcode | Till number for Buy Goods transactions |
| `MPESA_CALLBACK_BASE_URL` | Empty | Public HTTPS base URL for Daraja callbacks |

To test from another device on your local network, set `HOST=0.0.0.0` and add the device-facing host and port to `ALLOWED_HOSTS`.

## Project structure

```text
AI_Agents/
├── README.md
├── .vscode/
│   └── tasks.json
└── hm-vintage-shoes/
    ├── .env.example
    ├── server.py
    ├── data/
    │   ├── delivery.json
    │   └── products.json
    └── web/
        ├── css/
        ├── fonts/
        ├── img/
        ├── js/
        ├── partials/
        ├── index.html
        ├── shop.html
        ├── product.html
        ├── checkout.html
        └── order.html
```

The Python server renders shared header and footer partials, serves static assets, exposes the JSON API, stores orders, and communicates with Daraja. The browser handles catalogue rendering, filters, the shopping bag, checkout interactions, and order-status polling.

## API overview

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/config` | Returns currency, sizes, counties, delivery zones, and payment mode |
| `GET` | `/api/products` | Returns the catalogue with current size availability |
| `POST` | `/api/orders` | Validates the checkout and creates an order |
| `GET` | `/api/orders/{token}` | Returns the current public order status |
| `POST` | `/api/orders/{token}/simulate` | Applies a test outcome to a simulated order |
| `POST` | `/api/mpesa/callback/{secret}` | Receives payment results from Safaricom Daraja |

Order tokens and callback paths contain sensitive identifiers. Avoid publishing them in logs, screenshots, or issue reports.

## Data and persistence

- Product details, prices, images, and stock are maintained in `hm-vintage-shoes/data/products.json`.
- Counties and delivery zones are maintained in `hm-vintage-shoes/data/delivery.json`.
- The shopping bag is stored in the customer's browser.
- Orders and order items are stored in SQLite.
- Pending orders reserve stock for 10 minutes; paid orders continue to count against available stock.

By default, the database is stored outside the repository to prevent cloud-synchronization tools from locking it:

- Windows: `%LOCALAPPDATA%\hm-vintage-shoes\orders.sqlite3`
- Linux and macOS: `$XDG_DATA_HOME/hm-vintage-shoes/orders.sqlite3`, or the user's local data directory when `XDG_DATA_HOME` is not set

Set `HM_DB_PATH` if you need a different location.

## Development notes

- There is no dependency installation or frontend compilation step.
- Restart the Python server after changing backend code or data files.
- Refresh the browser after changing frontend files.
- Keep secrets in `.env`; use `.env.example` only as a documented template.
- Update product stock carefully: successful orders and active payment holds are deducted at runtime.
- Test checkout in simulation mode before connecting a Daraja environment.

When reporting a problem, include the Python version, browser, payment mode, steps to reproduce, and any non-sensitive server error output.
