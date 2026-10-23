"""Requirement 16: authentication, session expiry, role changes, revocation, CSRF, lockout, setup."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models import Role, User, UserSession
from tests.conftest import PASSWORD, ApiClient, app


def test_login_success_sets_httponly_cookie_and_returns_permissions(world, anon):
    r = anon.login("owner@test.test")
    assert r.status_code == 200
    body = r.json()
    assert body["role_code"] == "OWNER" and "settings.manage" in body["permissions"]
    set_cookie = r.headers.get_list("set-cookie")
    assert any("ab_session=" in c and "HttpOnly" in c for c in set_cookie)
    assert "password" not in r.text.lower() or "must_change_password" in r.text


def test_wrong_password_is_generic_and_audited(world, anon):
    r = anon.login("owner@test.test", "wrong-password")
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "Invalid email or password"
    r2 = anon.login("nobody@test.test", "wrong-password")
    assert r2.json()["error"]["message"] == "Invalid email or password"


def test_account_lockout_after_repeated_failures(world, anon, db):
    for _ in range(8):
        anon.login("fortcashier@test.test", "nope-nope-nope")
    r = anon.login("fortcashier@test.test", PASSWORD)
    assert r.status_code in (401, 429)
    u = db.scalar(select(User).where(User.email == "fortcashier@test.test"))
    db.refresh(u)
    assert u.locked_until is not None


def test_rate_limit_on_login(world):
    with ApiClient(app) as c:
        codes = [c.login("owner@test.test", "bad").status_code for _ in range(12)]
    assert 429 in codes


def test_protected_endpoint_requires_session(world, anon):
    assert anon.get("/books").status_code == 401


def test_csrf_required_for_unsafe_methods(world, client_for):
    c = client_for("owner")
    r = c.post("/categories", json={"name": "Poetry"}, headers={"X-CSRF-Token": "forged"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed"
    c.csrf = None
    assert c.post("/categories", json={"name": "Poetry"}).status_code == 403
    c.csrf = c.cookies.get("ab_csrf")
    assert c.post("/categories", json={"name": "Poetry"}).status_code == 201


def test_session_expiry_and_idle_timeout(world, client_for, db):
    c = client_for("owner")
    assert c.get("/auth/me").status_code == 200
    sess = db.scalar(select(UserSession).where(UserSession.user_id == world.users["owner"].id))
    sess.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    r = c.get("/auth/me")
    assert r.status_code == 401 and r.json()["error"]["code"] == "session_expired"

    c2 = client_for("owner")
    sess2 = db.scalar(select(UserSession).where(UserSession.user_id == world.users["owner"].id,
                                                UserSession.revoked_at.is_(None), UserSession.expires_at > datetime.now(UTC)))
    sess2.last_seen_at = datetime.now(UTC) - timedelta(hours=10)
    db.commit()
    assert c2.get("/auth/me").status_code == 401


def test_logout_revokes_session(world, client_for):
    c = client_for("owner")
    assert c.post("/auth/logout").status_code == 200
    assert c.get("/auth/me").status_code == 401


def test_role_change_takes_effect_immediately(world, client_for, db):
    cashier = client_for("fort_cashier")
    assert cashier.get("/reports/sales-summary").status_code == 403
    u = db.get(User, world.users["fort_cashier"].id)
    u.role_id = db.scalar(select(Role).where(Role.code == "STORE_MANAGER")).id
    db.commit()
    assert cashier.get("/reports/sales-summary").status_code == 200


def test_deactivation_revokes_access(world, client_for):
    cashier = client_for("fort_cashier")
    owner = client_for("owner")
    u = owner.get(f"/users/{world.users['fort_cashier'].id}").json()
    payload = {k: u[k] for k in ("email", "full_name", "phone", "employee_code", "designation", "joined_on",
                                 "role_id", "all_locations", "location_ids", "can_login")}
    payload["is_active"] = False
    assert owner.put(f"/users/{u['id']}", json=payload).status_code == 200
    assert cashier.get("/auth/me").status_code == 401


def test_password_change_revokes_other_sessions(world, client_for):
    a = client_for("owner")
    b = client_for("owner")
    r = a.post("/auth/change-password", json={"current_password": PASSWORD, "new_password": "N3w!Secure-Pass"})
    assert r.status_code == 200
    assert a.get("/auth/me").status_code == 200
    assert b.get("/auth/me").status_code == 401


def test_weak_password_rejected(world, client_for):
    a = client_for("owner")
    r = a.post("/auth/change-password", json={"current_password": PASSWORD, "new_password": "password"})
    assert r.status_code == 422
    assert r.json()["error"]["details"]


def test_admin_issued_reset_link_flow(world, client_for, anon):
    owner = client_for("owner")
    r = owner.post(f"/users/{world.users['fort_cashier'].id}/reset-password")
    assert r.status_code == 200
    token = r.json()["reset_url"].split("token=")[1]
    assert anon.post("/auth/password-reset/confirm", json={"token": token, "new_password": "Brand!New-Pass9"}).status_code == 200
    # one-time use
    assert anon.post("/auth/password-reset/confirm", json={"token": token, "new_password": "Brand!New-Pass8"}).status_code == 422
    assert anon.login("fortcashier@test.test", "Brand!New-Pass9").status_code == 200


def test_new_user_must_change_password(world, client_for):
    owner = client_for("owner")
    role_id = next(r["id"] for r in owner.get("/roles").json() if r["code"] == "CASHIER")
    r = owner.post("/users", json={"email": "new.cashier@test.test", "full_name": "New Cashier", "role_id": role_id,
                                   "location_ids": [str(world.fort.id)], "initial_password": "Initial!Pass42"})
    assert r.status_code == 201, r.text
    with ApiClient(app) as c:
        assert c.login("new.cashier@test.test", "Initial!Pass42").status_code == 200
        r = c.get("/books")
        assert r.status_code == 403 and r.json()["error"]["code"] == "password_change_required"
        assert c.post("/auth/change-password", json={"current_password": "Initial!Pass42",
                                                     "new_password": "Changed!Pass42"}).status_code == 200
        assert c.get("/books").status_code == 200


def test_setup_flow_requires_token_and_only_runs_once(monkeypatch, anon):
    monkeypatch.setenv("SETUP_TOKEN", "a-very-long-setup-token-123")
    assert anon.get("/setup/status").json()["needs_setup"] is True
    body = {"setup_token": "wrong-token-wrong-token", "organization_name": "Shop", "state_code": "27",
            "admin_email": "admin@test.test", "admin_name": "Admin", "admin_password": "Sh0p!Owner-Pass"}
    assert anon.post("/setup", json=body).status_code == 403
    body["setup_token"] = "a-very-long-setup-token-123"
    assert anon.post("/setup", json=body).status_code == 200
    assert anon.post("/setup", json=body).status_code == 409
    assert anon.login("admin@test.test", "Sh0p!Owner-Pass").status_code == 200


def test_health_endpoints(anon):
    assert anon.get("/health/live").json()["status"] == "ok"
    r = anon.get("/health/ready")
    assert r.status_code == 200 and r.json()["migration"] == "0002"
