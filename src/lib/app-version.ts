export interface AppVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseAppVersion(value: string): AppVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    throw new Error(`App 版本格式無效：${value}`);
  }

  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };

  if (!Number.isSafeInteger(version.major)) {
    throw new Error(`App major 版本超出安全範圍：${value}`);
  }
  if (version.minor > 9) {
    throw new Error(`App minor 版本只能是 0-9：${value}`);
  }
  if (version.patch > 99) {
    throw new Error(`App patch 版本只能是 0-99：${value}`);
  }

  return version;
}

export function formatAppVersion(version: AppVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function nextAppVersion(value: string): string {
  const version = parseAppVersion(value);

  if (version.patch < 99) {
    return formatAppVersion({ ...version, patch: version.patch + 1 });
  }
  if (version.minor < 9) {
    return formatAppVersion({ major: version.major, minor: version.minor + 1, patch: 0 });
  }
  if (version.major === Number.MAX_SAFE_INTEGER) {
    throw new Error(`App major 版本無法再進位：${value}`);
  }

  return formatAppVersion({ major: version.major + 1, minor: 0, patch: 0 });
}
