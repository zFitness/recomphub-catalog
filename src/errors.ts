export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

export class RateLimitError extends GitHubError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
