import logger from '@overleaf/logger'
import UserActivateController from './UserActivateController.mjs'
import CommentController from './CommentController.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'

export default {
  apply(webRouter) {
    logger.debug({}, 'Init UserActivate router with Manage Users & Comments support')

    // Both /admin/user and /admin/register render the Manage Users page
    webRouter.get(
      '/admin/user',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.registerNewUser
    )

    webRouter.get('/user/activate', UserActivateController.activateAccountPage)
    AuthenticationController.addEndpointToLoginWhitelist('/user/activate')

    webRouter.get(
      '/admin/register',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.registerNewUser
    )
    webRouter.post(
      '/admin/register',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.register
    )

    // Serve client-side JavaScript for user management page (same-origin to satisfy CSP)
    webRouter.get(
      '/admin/user-management.js',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.serveJs
    )

    // User management action routes
    webRouter.post(
      '/admin/user/:userId/delete',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.deleteUser
    )
    webRouter.post(
      '/admin/user/:userId/toggle-admin',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.toggleAdmin
    )
    webRouter.post(
      '/admin/user/:userId/reset-password',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.resetPassword
    )

    // Comment / Thread routes for editor review panel
    webRouter.get(
      '/project/:project_id/threads',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanReadProject,
      CommentController.getThreads
    )

    webRouter.post(
      '/project/:project_id/thread/:thread_id/messages',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.addMessage
    )

    webRouter.post(
      '/project/:project_id/thread/:thread_id/messages/:comment_id/edit',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.editMessage
    )

    webRouter.delete(
      '/project/:project_id/thread/:thread_id/messages/:comment_id',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.deleteMessage
    )

    webRouter.delete(
      '/project/:project_id/thread/:thread_id/own-messages/:comment_id',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.deleteMessage
    )

    // Resolve / Reopen / Delete threads (with or without doc_id)
    webRouter.post(
      '/project/:project_id/doc/:doc_id/thread/:thread_id/resolve',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.resolveThread
    )
    webRouter.post(
      '/project/:project_id/thread/:thread_id/resolve',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.resolveThread
    )

    webRouter.post(
      '/project/:project_id/doc/:doc_id/thread/:thread_id/reopen',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.reopenThread
    )
    webRouter.post(
      '/project/:project_id/thread/:thread_id/reopen',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.reopenThread
    )

    webRouter.delete(
      '/project/:project_id/doc/:doc_id/thread/:thread_id',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.deleteThread
    )
    webRouter.delete(
      '/project/:project_id/thread/:thread_id',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      CommentController.deleteThread
    )
  },
}
