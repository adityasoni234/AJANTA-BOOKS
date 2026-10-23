"""Optional SMTP integration. When unconfigured, callers must not pretend a message was sent."""

import logging
import smtplib
from email.message import EmailMessage

from app.core.config import get_settings

log = logging.getLogger("app.mailer")


class MailNotConfigured(RuntimeError):
    pass


def send_email(to: str, subject: str, body: str) -> None:
    s = get_settings()
    if not s.smtp_configured:
        raise MailNotConfigured("SMTP is not configured")
    msg = EmailMessage()
    msg["From"] = s.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as smtp:
        if s.smtp_starttls:
            smtp.starttls()
        if s.smtp_username:
            smtp.login(s.smtp_username, s.smtp_password or "")
        smtp.send_message(msg)
    log.info("email_sent", extra={"to_domain": to.split("@")[-1], "subject": subject})


def integration_status() -> dict:
    s = get_settings()
    return {
        "email": {"configured": s.smtp_configured, "provider": "SMTP" if s.smtp_configured else None},
        "whatsapp": {"configured": False, "provider": None},
        "payment_gateway": {"configured": False, "provider": None},
    }
