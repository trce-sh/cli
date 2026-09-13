import { beforeEach, vi } from 'vitest'

// Golden output describes a UTF-8 terminal on every OS. Platform detection has separate tests
// with explicit environments, including Windows consoles without WT_SESSION.
beforeEach(() => {
  vi.stubEnv('LC_ALL', 'en_US.UTF-8')
  vi.stubEnv('WT_SESSION', 'trce-test-terminal')
})
