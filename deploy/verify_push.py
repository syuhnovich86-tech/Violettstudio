from vita29.discussions.push import public_vapid_key
from vita29.settings import get_settings

key = public_vapid_key(get_settings().vapid_private_key_file)
print(f"PUSH_KEY_OK:{len(key or '')}")
