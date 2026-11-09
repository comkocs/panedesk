/** Model tools for the same browser pages shown in the right Sidebar. */
import type { Context } from '@panedesk/cordis'
import { defineTool } from '@panedesk/dsh-tools'
import type { AttachmentId } from '@panedesk/dsh-attachment'
import type {} from '@panedesk/dsh-attachment'
import type { ContentBlock } from '@panedesk/dsh-llm'
import { requestBrowser } from './host-browser.ts'

/** Browser results use the existing durable image attachment store. */
export const inject = ['tools', 'attachments']

/** @param ctx - Host services shared with ordinary Session tools. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser',
    description: 'Control the visible browser shared with the user. Navigate, read page text, capture a screenshot, click, type into the focused field, scroll, list tabs, or switch tabs. Coordinates are viewport CSS pixels. Desktop only.',
    parameters: {
      command: {
        required: true,
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { action: { type: 'string', const: 'navigate', required: true }, url: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['read', 'screenshot', 'tabs'], required: true } } },
          { type: 'object', additionalProperties: false, properties: { action: { type: 'string', const: 'click', required: true }, x: { type: 'number', required: true }, y: { type: 'number', required: true } } },
          { type: 'object', additionalProperties: false, properties: { action: { type: 'string', const: 'type', required: true }, text: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { action: { type: 'string', const: 'scroll', required: true }, x: { type: 'number', required: true }, y: { type: 'number', required: true }, deltaX: { type: 'number', required: true }, deltaY: { type: 'number', required: true } } },
          { type: 'object', additionalProperties: false, properties: { action: { type: 'string', const: 'switch', required: true }, tabId: { type: 'string', required: true } } },
        ],
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        text: { type: 'string', required: true },
        image: { type: 'object', additionalProperties: false, properties: {
          attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
          bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        } },
      } },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: value.text },
        ...value.image === undefined ? [] : [{ type: 'image' as const, attachment: { ...value.image, attachmentId: value.image.attachmentId as AttachmentId } }],
      ],
    },
    async execute({ command }, exec) {
      if (exec.agent === undefined) throw new Error('Browser tools require a Session')
      const result = await requestBrowser(exec.agent.session.id, command, exec.signal)
      if (result.screenshot === undefined) return { text: result.text }
      const image = await ctx.attachments.saveImage({ data: Buffer.from(result.screenshot, 'base64'), mediaType: 'image/png' })
      return { text: result.text, image: { attachmentId: image.attachmentId, mediaType: image.mediaType, bytes: image.bytes, width: image.width, height: image.height } }
    },
  })), 'ui-sidebar-browser.tools')
}
