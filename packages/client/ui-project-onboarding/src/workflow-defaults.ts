/** Locale-owned defaults shared by workflow settings and draft actions. */
export const workflowDefaults = {
  workflowRequirementsPrompt: {
    zh: '/workflow-pack 请读通用包里的《requirements-review.zh.md》,帮我设计产品研发文档,多轮改到定稿。',
    en: '/workflow-pack Read requirements-review.md in the general pack and help me design the product development documentation, refining it over multiple rounds until finalized.',
  },
  workflowSetupPrompt: {
    zh: '/workflow-pack 你是本项目第一窗,先读通用包里的《getting-started.zh.md》,照它搭建工作流再开工。',
    en: '/workflow-pack You are the first session for this project. Read getting-started.md in the general pack, follow it to build the workflow, then start work.',
  },
  workflowCheckupPrompt: {
    zh: '/workflow-pack 请读通用包里的《workflow-checkup.zh.md》,给这个项目做一次工作流体检。',
    en: '/workflow-pack Read workflow-checkup.md in the general pack and give this project a workflow checkup.',
  },
}

/** Three editable prompts, with independent English and Chinese text. */
export type WorkflowPrompts = typeof workflowDefaults

/** Workflow request keys paired with their localized labels and descriptions. */
export const workflowChoices = [
  ['newProject', 'newProjectHint', 'workflowRequirementsPrompt'],
  ['documentedProject', 'documentedProjectHint', 'workflowSetupPrompt'],
  ['existingProject', 'existingProjectHint', 'workflowCheckupPrompt'],
] as const
