import { expressify } from '@overleaf/promise-utils'
import logger from '@overleaf/logger'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import ChatManager from '../../../../app/src/Features/Chat/ChatManager.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'

async function getThreads(req, res) {
  const { project_id: projectId } = req.params
  const threads = await ChatApiHandler.promises.getThreads(projectId)
  await ChatManager.promises.injectUserInfoIntoThreads(threads || {})
  res.json(threads || {})
}

async function addMessage(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  const { content } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return res.sendStatus(401)
  }

  const message = await ChatApiHandler.promises.sendComment(
    projectId,
    threadId,
    userId,
    content
  )

  const user = await UserInfoManager.promises.getPersonalInfo(userId)
  message.user = UserInfoController.formatPersonalInfo(user)

  EditorRealTimeController.emitToRoom(
    projectId,
    'new-comment',
    threadId,
    message
  )

  res.status(200).json(message)
}

async function editMessage(req, res) {
  const { project_id: projectId, thread_id: threadId, comment_id: commentId } = req.params
  const { content } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return res.sendStatus(401)
  }

  await ChatApiHandler.promises.editMessage(
    projectId,
    threadId,
    commentId,
    userId,
    content
  )

  EditorRealTimeController.emitToRoom(
    projectId,
    'edit-message',
    threadId,
    commentId,
    content
  )

  res.sendStatus(204)
}

async function deleteMessage(req, res) {
  const { project_id: projectId, thread_id: threadId, comment_id: commentId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return res.sendStatus(401)
  }

  await ChatApiHandler.promises.deleteMessage(projectId, threadId, commentId)

  EditorRealTimeController.emitToRoom(
    projectId,
    'delete-message',
    threadId,
    commentId
  )

  res.sendStatus(204)
}

async function resolveThread(req, res) {
  const { project_id: projectId, thread_id: threadId, doc_id: docId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return res.sendStatus(401)
  }

  await ChatApiHandler.promises.resolveThread(projectId, threadId, userId)

  if (docId) {
    try {
      await DocumentUpdaterHandler.resolveThread(projectId, docId, threadId, userId)
    } catch (err) {
      logger.warn({ err, projectId, docId, threadId }, 'failed to resolve thread in document-updater')
    }
  }

  const user = await UserInfoManager.promises.getPersonalInfo(userId)
  const formattedUser = UserInfoController.formatPersonalInfo(user)

  EditorRealTimeController.emitToRoom(
    projectId,
    'resolve-thread',
    threadId,
    formattedUser
  )

  res.sendStatus(204)
}

async function reopenThread(req, res) {
  const { project_id: projectId, thread_id: threadId, doc_id: docId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return res.sendStatus(401)
  }

  await ChatApiHandler.promises.reopenThread(projectId, threadId)

  if (docId) {
    try {
      await DocumentUpdaterHandler.reopenThread(projectId, docId, threadId, userId)
    } catch (err) {
      logger.warn({ err, projectId, docId, threadId }, 'failed to reopen thread in document-updater')
    }
  }

  EditorRealTimeController.emitToRoom(
    projectId,
    'reopen-thread',
    threadId
  )

  res.sendStatus(204)
}

async function deleteThread(req, res) {
  const { project_id: projectId, thread_id: threadId, doc_id: docId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return res.sendStatus(401)
  }

  await ChatApiHandler.promises.deleteThread(projectId, threadId)

  if (docId) {
    try {
      await DocumentUpdaterHandler.deleteThread(projectId, docId, threadId, userId)
    } catch (err) {
      logger.warn({ err, projectId, docId, threadId }, 'failed to delete thread in document-updater')
    }
  }

  EditorRealTimeController.emitToRoom(
    projectId,
    'delete-thread',
    threadId
  )

  res.sendStatus(204)
}

export default {
  getThreads: expressify(getThreads),
  addMessage: expressify(addMessage),
  editMessage: expressify(editMessage),
  deleteMessage: expressify(deleteMessage),
  resolveThread: expressify(resolveThread),
  reopenThread: expressify(reopenThread),
  deleteThread: expressify(deleteThread),
}
