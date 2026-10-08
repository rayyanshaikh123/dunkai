import { Project } from '../models/Project.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, buildPaginatedResponse } from '../helpers/pagination.js';
import { logActivity } from '../helpers/activity.js';
import { notify } from '../helpers/notification.js';
import { assertCanCreateProject } from './billing.service.js';
import { env } from '../config/env.js';

const EDITABLE_FIELDS = ['title', 'description', 'tags', 'status', 'isFavourite'];
const ARTIFACT_FIELDS = ['requirements', 'architecture', 'bom', 'eda_data', 'pcb_ir', 'validation',
  'handoff_validation', 'documentation', 'code_generation', 'board'];

// ---- Access control ----

export const getProject = async (id, user, write = false) => {
  const project = await Project.findById(id).populate('owner members.user', 'name email avatar');
  if (!project) throw ApiError.notFound('Project not found');

  const isOwner = project.owner._id.toString() === user._id.toString();
  const member = project.members.find((m) => m.user?._id?.toString() === user._id.toString());

  if (!isOwner && !member) throw ApiError.forbidden('You do not have access to this project');
  if (write && !isOwner && member?.role !== 'editor') {
    throw ApiError.forbidden('You need editor access for this action');
  }

  return project;
};

// ---- List projects (paginated, filterable, sortable) ----

export const listProjects = async (user, query = {}) => {
  const { page, limit, skip, sort } = parsePagination(query);

  const baseFilter = {
    $or: [{ owner: user._id }, { 'members.user': user._id }],
  };

  // Apply status filter
  if (query.status && ['active', 'archived'].includes(query.status)) {
    baseFilter.status = query.status;
  }

  // Apply favourite filter
  if (query.favourite === 'true') {
    baseFilter.isFavourite = true;
  }

  // Apply search
  if (query.search) {
    baseFilter.$and = [
      baseFilter.$or ? { $or: baseFilter.$or } : {},
      { $text: { $search: query.search } },
    ];
    delete baseFilter.$or;
  }

  const [items, total] = await Promise.all([
    Project.find(baseFilter).populate('owner', 'name email avatar').sort(sort).skip(skip).limit(limit),
    Project.countDocuments(baseFilter),
  ]);

  return buildPaginatedResponse(items, total, { page, limit });
};

// ---- Recent projects ----

export const getRecentProjects = (user, limit = 5) =>
  Project.find({ $or: [{ owner: user._id }, { 'members.user': user._id }], status: 'active' })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .populate('owner', 'name email avatar');

// ---- Favourite projects ----

export const getFavouriteProjects = (user) =>
  Project.find({ $or: [{ owner: user._id }, { 'members.user': user._id }], isFavourite: true })
    .sort({ updatedAt: -1 })
    .populate('owner', 'name email avatar');

// ---- Create ----

export const createProject = async (data, user, req = null) => {
  await assertCanCreateProject(user);
  const project = await Project.create({
    title: data.title,
    description: data.description,
    tags: data.tags,
    owner: user._id,
  });

  await logActivity('project_created', user._id, { projectId: project._id, title: project.title }, req);
  return project;
};

// ---- Update ----

export const updateProject = async (id, data, user, req = null) => {
  const project = await getProject(id, user, true);
  const allowed = env.billingEnabled ? EDITABLE_FIELDS : [...EDITABLE_FIELDS, 'currentStage', ...ARTIFACT_FIELDS];
  for (const key of allowed) if (Object.hasOwn(data, key)) project[key] = data[key];

  // Mongoose Mixed-type fields need explicit markModified() for change detection
  for (const field of ARTIFACT_FIELDS) {
    if (!env.billingEnabled && Object.hasOwn(data, field)) {
      project.markModified(field);
    }
  }

  await project.save();

  await logActivity('project_updated', user._id, { projectId: project._id }, req);
  return project;
};

// ---- Delete ----

export const deleteProject = async (id, user, req = null) => {
  const project = await Project.findOne({ _id: id, owner: user._id });
  if (!project) throw ApiError.notFound('Project not found or you are not the owner');

  await project.deleteOne();
  const { deleteRuntimeArtifacts } = await import('./runtimeStorage.service.js');
  await deleteRuntimeArtifacts({ project: project._id });
  const { Chat } = await import('../models/Chat.js');
  const { Message } = await import('../models/Message.js');
  const chats = await Chat.find({ project: project._id }).select('_id');
  await Message.deleteMany({ chat: { $in: chats.map((chat) => chat._id) } });
  await Chat.deleteMany({ project: project._id });

  await logActivity('project_deleted', user._id, { projectId: id }, req);
  return project;
};

// ---- Archive / Unarchive ----

export const archiveProject = async (id, user, req = null) => {
  const project = await getProject(id, user, true);
  project.status = 'archived';
  await project.save();
  await logActivity('project_updated', user._id, { projectId: id, action: 'archived' }, req);
  return project;
};

// ---- Duplicate ----

export const duplicateProject = async (id, user, req = null) => {
  await assertCanCreateProject(user);
  const original = await getProject(id, user);
  const copy = original.toObject();

  delete copy._id;
  delete copy.__v;
  delete copy.createdAt;
  delete copy.updatedAt;

  copy.title = `${copy.title} (Copy)`;
  copy.owner = user._id;
  copy.members = [];
  copy.isFavourite = false;
  copy.status = 'active';

  const newProject = await Project.create(copy);

  await logActivity('project_created', user._id, { projectId: newProject._id, duplicatedFrom: id }, req);
  return newProject;
};

// ---- Toggle favourite ----

export const toggleFavourite = async (id, user) => {
  const project = await getProject(id, user);
  project.isFavourite = !project.isFavourite;
  await project.save();
  return { isFavourite: project.isFavourite };
};

// ---- Share ----

export const shareProject = async (id, email, role, user, req = null) => {
  const project = await getProject(id, user, true);
  const { User } = await import('../models/User.js');
  const target = await User.findOne({ email: email.toLowerCase() });

  if (!target) throw ApiError.notFound('User not found with that email');
  if (target._id.toString() === user._id.toString()) {
    throw ApiError.badRequest('You cannot share a project with yourself');
  }

  // Remove existing member if present
  project.members = project.members.filter(
    (m) => m.user.toString() !== target._id.toString()
  );
  project.members.push({ user: target._id, role: role || 'viewer' });
  await project.save();

  await notify(target._id, {
    type: 'project_shared',
    title: 'Project shared with you',
    message: `${user.name} shared "${project.title}" with you as ${role || 'viewer'}`,
    data: { projectId: project._id, role: role || 'viewer' },
    project: project._id,
  });

  await logActivity('project_shared', user._id, { projectId: id, sharedWith: target._id }, req);
  return project;
};

// ---- Remove member ----

export const removeMember = async (id, memberId, user) => {
  const project = await getProject(id, user, true);
  project.members = project.members.filter((m) => m.user.toString() !== memberId);
  await project.save();
  return project;
};

// ---- Search ----

export const searchProjects = async (user, query) => {
  const { page, limit, skip } = parsePagination(query);
  const filter = {
    $and: [
      { $or: [{ owner: user._id }, { 'members.user': user._id }] },
      { $text: { $search: query.q || '' } },
    ],
  };

  const [items, total] = await Promise.all([
    Project.find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .skip(skip)
      .limit(limit)
      .populate('owner', 'name email avatar'),
    Project.countDocuments(filter),
  ]);

  return buildPaginatedResponse(items, total, { page, limit });
};
