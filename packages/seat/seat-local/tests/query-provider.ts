/** Test-only corpus reader uses the public query implementation without a search index. */
import SessionQueryEngine from '@panedesk/dsh-session-query'

/** Search is deliberately unavailable; exact reads retain the production corpus behavior. */
export class ExactSessionQuery extends SessionQueryEngine {
  override searchSessions(): ReturnType<SessionQueryEngine['searchSessions']> {
    return Promise.reject(new Error('Search is not installed'))
  }
  override searchEvents(): ReturnType<SessionQueryEngine['searchEvents']> {
    return Promise.reject(new Error('Search is not installed'))
  }
}
