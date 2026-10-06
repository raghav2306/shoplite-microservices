# HTTP API reference

The base path is `/api`, served by api-gateway. On EKS it's reachable at
`https://<domain>/api/...` through the ALB.

**Auth:** `Authorization: Bearer <token>`, using the token from
`POST /api/users/login`.
**Errors:** always JSON, `{"error": "<message>"}`.

| Status | Meaning |
|---|---|
| 400 | Invalid input |
| 401 | Missing or invalid token, or wrong credentials |
| 403 | Authenticated but not an admin |
| 404 | Not found, including another user's order |
| 409 | Conflict: email already registered, out of stock, or an invalid status change |
| 503 | A backend service is unavailable |

## Users

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/api/users/register` | — | `{name, email, password}` | 201 `{id, name, email}` |
| POST | `/api/users/login` | — | `{email, password}` | 200 `{token, userId}` |
| GET | `/api/users/me` | user | — | 200 `{id, name, email, role}` |

## Products

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| GET | `/api/products` | — | — | 200 `[{id, name, description, price, stock}]` |
| GET | `/api/products/:id` | — | — | 200 product |
| POST | `/api/products` | admin | `{name, description?, price ≥ 0, stock ≥ 0 (integer)}` | 201 product |
| PUT | `/api/products/:id` | admin | full product (same fields as POST) | 200 product |
| DELETE | `/api/products/:id` | admin | — | 204 |

## Orders (current user)

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/api/orders` | user | `{items: [{productId, quantity}]}`; any prices sent are ignored | 201 `{orderId, status, totalAmount}` |
| GET | `/api/orders` | user | — | 200 orders, newest first |
| GET | `/api/orders/:id` | user | — | 200 order (404 if it belongs to someone else) |
| DELETE | `/api/orders/:id` | user | — | 200; cancels the order (allowed only while `pending` or `confirmed`) |

## Admin

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| GET | `/api/admin/orders?status=<status>` | admin | — | 200 all orders, newest first, optionally filtered |
| PATCH | `/api/admin/orders/:id/status` | admin | `{status}` | 200 `{success, status}` |

Allowed status changes: `pending → confirmed → shipped → delivered`, and
`pending | confirmed → cancelled`. A disallowed change returns 409, and an
unknown status value returns 400.

## Example

```bash
BASE=https://abc.com
curl -s -X POST $BASE/api/users/register -H 'Content-Type: application/json' \
  -d '{"name":"Test","email":"test@example.com","password":"pw123456"}'
TOKEN=$(curl -s -X POST $BASE/api/users/login -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"pw123456"}' | jq -r .token)
curl -s $BASE/api/users/me -H "Authorization: Bearer $TOKEN"
```

For automated checks after a deploy, use `scripts/smoke-test.sh`
(see [RUNBOOK](RUNBOOK.md#verify-a-deployment)).
