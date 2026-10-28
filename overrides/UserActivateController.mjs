import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserRegistrationHandler from '../../../../app/src/Features/User/UserRegistrationHandler.mjs'
import UserDeleter from '../../../../app/src/Features/User/UserDeleter.mjs'
import ErrorController from '../../../../app/src/Features/Errors/ErrorController.mjs'
import OneTimeTokenHandler from '../../../../app/src/Features/Security/OneTimeTokenHandler.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { db, ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import { expressify } from '@overleaf/promise-utils'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))

async function manageUsersPage(req, res, next) {
  const users = await db.users
    .find(
      {},
      {
        projection: {
          _id: 1,
          email: 1,
          first_name: 1,
          last_name: 1,
          isAdmin: 1,
          signUpDate: 1,
          lastLoggedIn: 1,
          lastActive: 1,
          loginCount: 1,
          holdingAccount: 1,
        },
      }
    )
    .sort({ signUpDate: -1 })
    .toArray()

  const sessionUser = SessionManager.getSessionUser(req.session)
  const csrfToken = req.csrfToken ? req.csrfToken() : (res.locals && (res.locals.csrfToken || res.locals._csrf)) || ''

  res.render(Path.resolve(__dirname, '../views/user/manage_users'), {
    title: 'Manage Users',
    users,
    currentUser: sessionUser,
    csrfToken,
    _csrf: csrfToken,
  })
}

async function generateActivationLink(req, user) {
  const ONE_WEEK = 7 * 24 * 60 * 60 // seconds
  const token = await OneTimeTokenHandler.promises.getNewToken(
    'password',
    { user_id: user._id.toString(), email: user.email },
    { expiresIn: ONE_WEEK }
  )

  const host = req.get('host')
  const protocol = req.protocol || 'http'
  const baseUrl = host ? `${protocol}://${host}` : settings.siteUrl
  return `${baseUrl}/user/activate?token=${token}&user_id=${user._id}`
}

async function register(req, res, next) {
  const { email, emails } = req.body
  let rawEmails = []
  if (Array.isArray(emails)) {
    rawEmails = emails
  } else if (typeof emails === 'string' && emails.trim()) {
    rawEmails = emails.split(/[\s,;\n\r]+/)
  } else if (typeof email === 'string' && email.trim()) {
    rawEmails = email.split(/[\s,;\n\r]+/)
  }

  const validEmails = rawEmails.map(e => e.trim().toLowerCase()).filter(e => e.includes('@'))
  if (validEmails.length === 0) {
    return res.status(422).json({ error: 'No valid email addresses provided' })
  }

  const results = []
  for (const em of validEmails) {
    try {
      let user = await UserGetter.promises.getUserByAnyEmail(em)
      if (user) {
        const setNewPasswordUrl = await generateActivationLink(req, user)
        results.push({
          _id: user._id,
          email: user.email,
          first_name: user.first_name || '',
          last_name: user.last_name || '',
          isAdmin: !!user.isAdmin,
          signUpDate: user.signUpDate || new Date(),
          loginCount: user.loginCount || 0,
          setNewPasswordUrl,
          success: true,
          alreadyExisted: true,
        })
        continue
      }

      user = await UserRegistrationHandler.promises.registerNewUser({
        email: em,
        holdingAccount: true,
      })

      // Try sending activation email if configured, but never fail registration if mail server is missing
      try {
        if (UserRegistrationHandler.promises.sendActivationEmail) {
          await UserRegistrationHandler.promises.sendActivationEmail(user)
        }
      } catch (mailErr) {
        logger.warn({ mailErr, email: em }, 'activation email not sent (no mail server configured), direct link will be displayed')
      }

      const setNewPasswordUrl = await generateActivationLink(req, user)

      results.push({
        _id: user._id,
        email: user.email,
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        isAdmin: !!user.isAdmin,
        signUpDate: user.signUpDate || new Date(),
        loginCount: user.loginCount || 0,
        setNewPasswordUrl,
        success: true,
      })
    } catch (err) {
      logger.error({ err, email: em }, 'failed to register user in admin panel')
      results.push({
        email: em,
        success: false,
        error: err.message || 'Registration failed',
      })
    }
  }

  const firstSuccessful = results.find(r => r.success)
  res.json({
    email: firstSuccessful ? firstSuccessful.email : validEmails[0],
    setNewPasswordUrl: firstSuccessful ? firstSuccessful.setNewPasswordUrl : null,
    results,
  })
}

async function deleteUser(req, res, next) {
  const { userId } = req.params
  const sessionUser = SessionManager.getSessionUser(req.session)
  const currentUserId = (sessionUser?._id || sessionUser?.id)?.toString()

  if (currentUserId && currentUserId === userId.toString()) {
    return res.status(400).json({ error: 'Cannot delete your own account' })
  }

  const user = await UserGetter.promises.getUser(userId, { _id: 1, email: 1 })
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  logger.info({ userId, email: user.email }, 'admin deleting user')
  await UserDeleter.promises.deleteUser(user._id, {
    force: true,
    ipAddress: req.ip || '0.0.0.0',
    skipEmail: true,
    deleterUser: sessionUser,
  })

  res.json({ success: true, email: user.email })
}

async function toggleAdmin(req, res, next) {
  const { userId } = req.params
  const sessionUser = SessionManager.getSessionUser(req.session)
  const currentUserId = (sessionUser?._id || sessionUser?.id)?.toString()

  if (currentUserId && currentUserId === userId.toString()) {
    return res
      .status(400)
      .json({ error: 'Cannot change your own admin privileges' })
  }

  const user = await UserGetter.promises.getUser(userId, { _id: 1, isAdmin: 1 })
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const newAdminStatus = !user.isAdmin
  await db.users.updateOne(
    { _id: new ObjectId(userId) },
    { $set: { isAdmin: newAdminStatus } }
  )

  logger.info(
    { userId, newAdminStatus },
    'admin changed user isAdmin privilege'
  )
  res.json({ success: true, isAdmin: newAdminStatus })
}

async function resetPassword(req, res, next) {
  const { userId } = req.params
  const user = await UserGetter.promises.getUser(userId, { _id: 1, email: 1 })
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const ONE_WEEK = 7 * 24 * 60 * 60 // seconds
  const token = await OneTimeTokenHandler.promises.getNewToken(
    'password',
    { user_id: user._id.toString(), email: user.email },
    { expiresIn: ONE_WEEK }
  )

  const host = req.get('host')
  const protocol = req.protocol || 'http'
  const baseUrl = host ? `${protocol}://${host}` : settings.siteUrl
  const setNewPasswordUrl = `${baseUrl}/user/activate?token=${token}&user_id=${user._id}`

  res.json({ success: true, setNewPasswordUrl, email: user.email })
}

async function activateAccountPage(req, res, next) {
  if (req.query.user_id == null || req.query.token == null) {
    return ErrorController.notFound(req, res)
  }

  if (typeof req.query.user_id !== 'string') {
    return ErrorController.forbidden(req, res)
  }

  const user = await UserGetter.promises.getUser(req.query.user_id, {
    email: 1,
    loginCount: 1,
  })

  if (!user) {
    return ErrorController.notFound(req, res)
  }

  if (user.loginCount > 0) {
    return res.redirect('/login')
  }

  req.session.doLoginAfterPasswordReset = true

  res.render(Path.resolve(__dirname, '../views/user/activate'), {
    title: 'activate_account',
    email: user.email,
    token: req.query.token,
  })
}

function serveJs(req, res) {
  res.type('application/javascript')
  res.sendFile(Path.resolve(__dirname, 'user-management.js'))
}

export default {
  registerNewUser: expressify(manageUsersPage),
  register: expressify(register),
  deleteUser: expressify(deleteUser),
  toggleAdmin: expressify(toggleAdmin),
  resetPassword: expressify(resetPassword),
  activateAccountPage: expressify(activateAccountPage),
  serveJs: expressify(serveJs),
}
