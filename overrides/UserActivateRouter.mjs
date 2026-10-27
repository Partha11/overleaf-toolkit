import logger from '@overleaf/logger'
import UserActivateController from './UserActivateController.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'

export default {
  apply(webRouter) {
    logger.debug({}, 'Init UserActivate router with Manage Users support')

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
  },
}
