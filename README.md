# aminovich7.github.io

Portfolio of **Mukhammad Batoshev**, Python backend developer (FastAPI, Django REST Framework).

- **Portfolio:** https://aminovich7.github.io/
- **Clinic CRM live demo:** https://aminovich7.github.io/clinic-crm-demo/ — the real interface of a clinic finance and payroll system built with FastAPI, running in the browser on fictional sample data (English, or the original Uzbek under `/uz/`).

## About the demo

The Clinic CRM's source is private (it was built for a real clinic), so the demo is a static build of its real frontend. Its API calls are answered in the browser by `clinic-crm-demo/static/demo/crm-mock.js`, a JavaScript port of the backend's rules: receipts and doctor commissions with per-receipt `Decimal` rounding, payroll proration by working day, the pharmacy ledger, voiding and restoring, and role-based access. The port was checked against the real FastAPI API on the same dataset, request for request.

All names, amounts and receipts in the demo are invented, and anything changed in the demo stays in the visitor's browser.
