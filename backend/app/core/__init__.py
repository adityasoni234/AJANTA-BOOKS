import email_validator

# Allow the reserved ".test" TLD (RFC 2606) so demo/test accounts can never collide with real
# mailboxes. All other special-use domains stay rejected.
email_validator.SPECIAL_USE_DOMAIN_NAMES = [d for d in email_validator.SPECIAL_USE_DOMAIN_NAMES if d != "test"]

# Serialise Decimal money values as exact strings (never floats) in every JSON response,
# including endpoints that return plain dicts.
from decimal import Decimal  # noqa: E402

import fastapi.encoders  # noqa: E402

fastapi.encoders.ENCODERS_BY_TYPE[Decimal] = str
