import os


def get(name, default=""):
    return os.getenv(name, default).strip()


def get_bool(name, default="false"):
    return get(name, default).lower() == "true"


def get_int(name, default):
    try:
        return int(get(name, str(default)))
    except ValueError:
        return default
