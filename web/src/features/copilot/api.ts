/** 给别的包用的非组件出口。组件出口在 index.tsx。 */
export { loadActions, buttonsOf, scopesOf, toCopilotActions } from './actions'
export type { ActionDef, ActionScope, ActionsFile, ActionType } from './actions'
export { buildEnvelope, missingContext, missingHint, pointer } from './context'
export type { Envelope } from './context'
