export function isPipedreamEnabled(): boolean {
  // Default to Pipedream-enabled when PIPEDREAM_STATE is not set.
  // Only when explicitly set to 'false' do we switch to native mode.
  return process.env.PIPEDREAM_STATE !== 'false'
}

