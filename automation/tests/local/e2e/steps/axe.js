import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

// Shared axe helper for the accessibility suite and flow-level scans that
// need to check a state no static page path reaches (the brochure QA review
// section, issue #630). The policy is the same everywhere: fail on
// critical/serious, leave moderate/minor as warnings.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

export const scanPage = (page) => new AxeBuilder({ page }).withTags(AXE_TAGS)

export function assertNoCriticalOrSerious(violations) {
  const blocking = violations.filter((v) => ['critical', 'serious'].includes(v.impact))
  const summary = blocking.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`).join('; ')
  expect(blocking, `axe found blocking violations: ${summary}`).toHaveLength(0)
}
