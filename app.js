(() => {
  const MANIFEST_PATH = 'data/manifest.json';
  const STORAGE_KEY = 'cppQuizLab.v1';
  const STORAGE_VERSION = 9;

  const els = {
    categoryTree: document.getElementById('categoryTree'),
    quizStage: document.getElementById('quizStage'),
    searchForm: document.getElementById('searchForm'),
    searchInput: document.getElementById('searchInput'),
    includeWrongToggle: document.getElementById('includeWrongToggle'),
    onlyWrongToggle: document.getElementById('onlyWrongToggle'),
    reviewWrongBtn: document.getElementById('reviewWrongBtn'),
    resetProgressBtn: document.getElementById('resetProgressBtn'),
    overallScore: document.getElementById('overallScore'),
    overallDetail: document.getElementById('overallDetail'),
    completedCount: document.getElementById('completedCount'),
    wrongCount: document.getElementById('wrongCount'),
    wrongDetail: document.getElementById('wrongDetail')
  };

  const state = {
    manifest: null,
    itemMap: new Map(),
    groupMap: new Map(),
    quizCache: new Map(),
    sourceCache: new Map(),
    session: null,
    storage: loadStorage()
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();
    restorePreferences();
    renderStats();

    try {
      state.manifest = await fetchJson(MANIFEST_PATH);
      indexManifest(state.manifest);
      if (pruneStorageToManifest()) {
        saveStorage();
        renderStats();
      }
      renderCategoryTree();

      if (hasResumableSession()) {
        resumeActiveSession();
      } else {
        renderWelcome();
      }
    } catch (error) {
      console.error(error);
      els.categoryTree.className = 'category-tree';
      els.categoryTree.innerHTML = `
        <p class="error-empty">
          I can't load the quiz content.
          Start the app with a small local server, for example:<br>
          <code>python3 -m http.server 8000</code>
        </p>`;
      renderEmpty(
        'Content not loaded',
        'Browsers often block local requests when a page is opened directly. Serve this folder locally and reload the page.'
      );
    }
  }

  function bindEvents() {
    els.searchForm.addEventListener('submit', handleSearch);

    els.includeWrongToggle.addEventListener('change', savePreferencesFromControls);
    els.onlyWrongToggle.addEventListener('change', savePreferencesFromControls);

    els.categoryTree.addEventListener('click', (event) => {
      const quizButton = event.target.closest('[data-start-quiz]');
      if (quizButton) {
        startQuizById(quizButton.dataset.startQuiz);
        return;
      }

      const categoryButton = event.target.closest('[data-start-category]');
      if (categoryButton) {
        startCategory(categoryButton.dataset.startCategory);
        return;
      }

      const groupButton = event.target.closest('[data-start-group]');
      if (groupButton) {
        startGroup(groupButton.dataset.startGroup);
      }
    });

    els.quizStage.addEventListener('click', (event) => {
      const resumeButton = event.target.closest('[data-resume-session]');
      if (resumeButton) {
        resumeActiveSession();
        return;
      }

      const discardButton = event.target.closest('[data-discard-session]');
      if (discardButton) {
        discardActiveSession();
        return;
      }

      const startCategoryButton = event.target.closest('[data-start-category]');
      if (startCategoryButton) {
        startCategory(startCategoryButton.dataset.startCategory);
        return;
      }

      const startGroupButton = event.target.closest('[data-start-group]');
      if (startGroupButton) {
        startGroup(startGroupButton.dataset.startGroup);
        return;
      }

      const startQuizButton = event.target.closest('[data-start-quiz]');
      if (startQuizButton) {
        startQuizById(startQuizButton.dataset.startQuiz);
        return;
      }

      const confirmButton = event.target.closest('#confirmAnswerBtn');
      if (confirmButton) {
        confirmAnswer();
        return;
      }

      const nextButton = event.target.closest('#nextQuestionBtn');
      if (nextButton) {
        goToNextQuestion();
        return;
      }

      const previousButton = event.target.closest('#previousQuestionBtn');
      if (previousButton) {
        goToPreviousQuestion();
        return;
      }

      const reviewCurrentWrongButton = event.target.closest('[data-review-current-wrong]');
      if (reviewCurrentWrongButton) {
        startMissedReviewForQuiz(reviewCurrentWrongButton.dataset.reviewCurrentWrong, {
          queue: state.session?.queue ?? []
        });
        return;
      }

      const continueButton = event.target.closest('[data-continue-queue]');
      if (continueButton && state.session?.queue?.length) {
        const [nextQuizId, ...remainingQueue] = state.session.queue;
        startQuizById(nextQuizId, { queue: remainingQueue });
        return;
      }

      const welcomeButton = event.target.closest('[data-show-welcome]');
      if (welcomeButton) {
        persistActiveSession();
        renderWelcome();
      }
    });

    els.quizStage.addEventListener('change', (event) => {
      if (event.target.matches('input[name="answer"]')) {
        selectAnswer(event.target.value);
      }
    });

    els.reviewWrongBtn.addEventListener('click', () => {
      const questions = getActiveWrongQuestions();
      if (!questions.length) {
        renderEmpty('No active misses', 'Missed questions will appear here for review.');
        return;
      }

      startSession({
        id: 'review:all-active-wrong',
        type: 'review',
        title: 'Missed Question Review',
        description: 'Practice session built from active missed questions. It does not change your overall quiz score.',
        questions,
        isOfficial: false,
        queue: []
      });
    });

    els.resetProgressBtn.addEventListener('click', () => {
      const confirmed = window.confirm('Reset scores, saved quiz progress, and missed questions?');
      if (!confirmed) return;
      state.storage = makeEmptyStorage();
      state.session = null;
      saveStorage();
      restorePreferences();
      renderStats();
      renderCategoryTree();
      renderWelcome();
    });
  }

  async function fetchJson(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Unable to load ${path}: ${response.status}`);
    }
    return response.json();
  }

  function indexManifest(manifest) {
    state.itemMap.clear();
    state.groupMap.clear();
    for (const category of manifest.categories ?? []) {
      indexManifestItems(category.items ?? [], category);
    }
  }

  function indexManifestItems(items, category, parentGroup = null) {
    for (const item of items) {
      const enriched = {
        ...item,
        categoryId: category.id,
        categoryTitle: category.title,
        parentGroupId: parentGroup?.id ?? null,
        parentGroupTitle: parentGroup?.title ?? null
      };

      if (item.items?.length) {
        state.groupMap.set(item.id, enriched);
        indexManifestItems(item.items, category, enriched);
        continue;
      }

      if (item.path) {
        state.itemMap.set(item.id, enriched);
      }
    }
  }

  function pruneStorageToManifest() {
    const validQuizIds = new Set(state.itemMap.keys());
    const validCategoryIds = new Set((state.manifest?.categories ?? []).map((category) => category.id));
    let changed = false;

    const getQuizIdFromKey = (key) => (typeof key === 'string' ? key.split('::')[0] : null);
    const isValidQuizId = (quizId) => typeof quizId === 'string' && validQuizIds.has(quizId);
    const isValidCategoryId = (categoryId) => typeof categoryId === 'string' && validCategoryIds.has(categoryId);

    for (const [quizId, result] of Object.entries(state.storage.results ?? {})) {
      if (!isValidQuizId(quizId) || (result?.quizId && !isValidQuizId(result.quizId))) {
        delete state.storage.results[quizId];
        changed = true;
      } else if (result?.quizId !== quizId) {
        result.quizId = quizId;
        changed = true;
      }
    }

    for (const records of [state.storage.wrong, state.storage.recovered]) {
      for (const [key, record] of Object.entries(records ?? {})) {
        const quizId = record?.quizId ?? record?.question?.sourceQuizId ?? getQuizIdFromKey(key);
        if (!isValidQuizId(quizId)) {
          delete records[key];
          changed = true;
          continue;
        }

        if (record.quizId !== quizId) {
          record.quizId = quizId;
          changed = true;
        }
        if (record.question?.sourceQuizId && record.question.sourceQuizId !== quizId) {
          record.question.sourceQuizId = quizId;
          changed = true;
        }
        const categoryId = state.itemMap.get(quizId)?.categoryId;
        if (!isValidCategoryId(record.category) && categoryId) {
          record.category = categoryId;
          changed = true;
        }
      }
    }

    const nextQuizProgress = {};
    for (const [quizId, rawSession] of Object.entries(state.storage.quizProgress ?? {})) {
      const session = hydrateSession(rawSession);
      const sourceQuizId = session?.sourceQuizId ?? quizId;
      if (!session?.isOfficial || !isValidQuizId(sourceQuizId)) {
        changed = true;
        continue;
      }

      const prunedSession = pruneSessionReferencesToManifest(session, validQuizIds);
      if (!prunedSession || prunedSession.sourceQuizId !== sourceQuizId) {
        changed = true;
        continue;
      }
      if (quizId !== sourceQuizId) changed = true;
      nextQuizProgress[sourceQuizId] = serializeSession(prunedSession);
    }
    if (JSON.stringify(state.storage.quizProgress ?? {}) !== JSON.stringify(nextQuizProgress)) {
      state.storage.quizProgress = nextQuizProgress;
      changed = true;
    }

    const activeSession = hydrateSession(state.storage.activeSession);
    const prunedActiveSession = activeSession
      ? pruneSessionReferencesToManifest(activeSession, validQuizIds)
      : null;
    const nextActiveSession = prunedActiveSession ? serializeSession(prunedActiveSession) : null;
    if (JSON.stringify(state.storage.activeSession ?? null) !== JSON.stringify(nextActiveSession)) {
      state.storage.activeSession = nextActiveSession;
      changed = true;
    }

    return changed;
  }

  function pruneSessionReferencesToManifest(session, validQuizIds) {
    if (!session || typeof session !== 'object') return null;
    if (session.isOfficial && !validQuizIds.has(session.sourceQuizId)) return null;

    const questions = session.questions ?? [];
    const hasUnknownQuestion = questions.some((question) => (
      question.sourceQuizId && !validQuizIds.has(question.sourceQuizId)
    ));
    if (hasUnknownQuestion) return null;

    session.queue = (session.queue ?? []).filter((quizId) => validQuizIds.has(quizId));
    return session;
  }

  function renderWelcome() {
    const currentTransientSession = !state.session?.isOfficial && isSessionCheckpointable(state.session)
      ? state.session
      : null;
    const resumableSession = currentTransientSession ?? hydrateSession(state.storage.activeSession);
    const resumeMarkup = resumableSession ? renderResumeCard(resumableSession) : '';

    els.quizStage.innerHTML = `
      <div class="welcome-card">
        ${resumeMarkup}
        <p class="eyebrow">Ready?</p>
        <h2>Choose a quiz or start the tutorial</h2>
        <p>
          The tutorial path is expanded by default. Each module is a separate quiz
          with its own score contributing to the overall score.
        </p>
        <div class="quiz-actions" style="justify-content:flex-start">
          <button type="button" class="primary-button" data-start-category="tutorial">Start tutorial path</button>
        </div>
      </div>`;
  }

  function renderResumeCard(session) {
    const questionNumber = Math.min((session.index ?? 0) + 1, session.questions?.length ?? 1);
    const total = session.questions?.length ?? 0;
    const correctSoFar = (session.responses ?? []).filter((response) => response.correct).length;
    const status = session.confirmed
      ? 'answer confirmed, ready to continue'
      : session.selectedAnswer
        ? 'answer selected, not confirmed yet'
        : 'waiting for an answer';

    return `
      <div class="resume-card">
        <div>
          <p class="eyebrow">Saved Session</p>
          <h3>${escapeHtml(session.title ?? 'Active quiz')}</h3>
          <p>
            Question ${questionNumber} of ${total} - ${correctSoFar} correct so far - ${escapeHtml(status)}.
          </p>
        </div>
        <div class="resume-actions">
          <button type="button" class="secondary-button" data-resume-session>Resume here</button>
          <button type="button" class="ghost-button" data-discard-session>Discard checkpoint</button>
        </div>
      </div>`;
  }

  function renderCategoryTree() {
    if (!state.manifest) return;

    els.categoryTree.className = 'category-tree';
    els.categoryTree.innerHTML = state.manifest.categories.map((category) => {
      const isTutorial = category.id === 'tutorial';
      const items = category.items ?? [];
      const itemButtons = items.map((item) => renderManifestItem(item, category)).join('');
      const hasLeafItems = collectLeafItems(items).length > 0;
      const description = category.description ? `<span>${escapeHtml(category.description)}</span>` : '';
      const actions = hasLeafItems
        ? `<div class="category-actions">
            <button type="button" class="secondary-button full" data-start-category="${escapeAttr(category.id)}">
              Start entire category
            </button>
          </div>`
        : '<p class="error-empty">No quizzes yet.</p>';

      return `
        <details class="category-block" ${isTutorial ? 'open' : ''}>
          <summary class="category-summary">
            <div>
              <strong>${escapeHtml(category.title)}</strong>
              ${description}
            </div>
            <span class="chevron">›</span>
          </summary>
          <div class="category-body">
            ${actions}
            ${itemButtons}
          </div>
        </details>`;
    }).join('');
  }

  function renderManifestItem(item, category) {
    if (item.items?.length) {
      return renderQuizGroup(item, category);
    }
    return renderQuizLink({
      ...item,
      categoryId: category.id,
      categoryTitle: category.title
    }, category);
  }

  function renderQuizGroup(group, category) {
    const description = group.topic || group.description
      ? `<span>${escapeHtml(group.topic ?? group.description)}</span>`
      : '';
    const children = (group.items ?? []).map((item) => renderManifestItem(item, category)).join('');

    return `
      <details class="category-block quiz-subgroup" open>
        <summary class="category-summary">
          <div>
            <strong>${escapeHtml(group.title)}</strong>
            ${description}
          </div>
          <span class="chevron">›</span>
        </summary>
        <div class="category-body">
          <div class="category-actions">
            <button type="button" class="secondary-button full" data-start-group="${escapeAttr(group.id)}">
              Start this group
            </button>
          </div>
          ${children}
        </div>
      </details>`;
  }

  function renderQuizLink(item, category) {
    const result = state.storage.results[item.id];
    const progress = getStoredQuizProgressSummary(item.id);
    const activeWrong = getActiveWrongCount({ quizId: item.id });
    const isCurrentSession = state.session?.sourceQuizId === item.id && isSessionCheckpointable(state.session);
    const resultBadge = progress
      ? `<span class="badge warning">${progress.correct}/${progress.total}</span>`
      : result
        ? `<span class="badge success">${result.bestCorrect}/${result.total}</span>`
        : `<span class="badge">New</span>`;
    const wrongBadge = activeWrong > 0
      ? `<span class="badge danger">${activeWrong}</span>`
      : '';
    const currentBadge = isCurrentSession
      ? '<span class="badge warning">In progress</span>'
      : '';
    const level = item.level ? `Level ${escapeHtml(String(item.level))}` : escapeHtml(category.title);

    return `
      <button type="button" class="quiz-link" data-start-quiz="${escapeAttr(item.id)}">
        <span>
          <strong>${escapeHtml(item.title)}</strong>
          <small>${level}${item.topic ? ` · ${escapeHtml(item.topic)}` : ''}</small>
        </span>
        <span>${resultBadge}${wrongBadge}${currentBadge}</span>
      </button>`;
  }

  async function startCategory(categoryId) {
    const category = state.manifest?.categories?.find((item) => item.id === categoryId);
    const leafItems = category ? collectLeafItems(category.items ?? []) : [];
    if (!category || !leafItems.length) {
      renderEmpty('Empty category', 'There are no quizzes in this category.');
      return;
    }

    if (els.onlyWrongToggle.checked) {
      const quizIds = leafItems.map((item) => item.id);
      const questions = getActiveWrongQuestions({ quizIds });
      if (!questions.length) {
        renderEmpty(
          'No missed questions for this category',
          `There are no active missed questions in "${category.title}". Turn off "missed questions only" to take the full quiz.`
        );
        return;
      }

      startSession({
        id: `review:category:${category.id}`,
        type: 'review',
        title: `Misses - ${category.title}`,
        description: 'Review the active missed questions from the selected category. It does not change your overall quiz score.',
        questions,
        isOfficial: false,
        queue: []
      });
      return;
    }

    const [first, ...rest] = leafItems;
    await startQuizById(first.id, { queue: rest.map((item) => item.id) });
  }

  async function startGroup(groupId) {
    const group = state.groupMap.get(groupId);
    const leafItems = group ? collectLeafItems(group.items ?? []) : [];
    if (!group || !leafItems.length) {
      renderEmpty('Empty group', 'There are no quizzes in this group.');
      return;
    }

    if (els.onlyWrongToggle.checked) {
      const quizIds = leafItems.map((item) => item.id);
      const questions = getActiveWrongQuestions({ quizIds });
      if (!questions.length) {
        renderEmpty(
          'No missed questions for this group',
          `There are no active missed questions in "${group.title}". Turn off "missed questions only" to take the full quiz.`
        );
        return;
      }

      startSession({
        id: `review:group:${group.id}`,
        type: 'review',
        title: `Misses - ${group.title}`,
        description: 'Review the active missed questions from the selected group. It does not change your overall quiz score.',
        questions,
        isOfficial: false,
        queue: []
      });
      return;
    }

    const [first, ...rest] = leafItems;
    await startQuizById(first.id, { queue: rest.map((item) => item.id) });
  }

  function collectLeafItems(items) {
    const leafItems = [];
    for (const item of items ?? []) {
      if (item.items?.length) {
        leafItems.push(...collectLeafItems(item.items));
      } else if (item.path) {
        leafItems.push(item);
      }
    }
    return leafItems;
  }

  async function startQuizById(quizId, options = {}) {
    persistActiveSession();

    const item = state.itemMap.get(quizId);
    if (!item) {
      renderEmpty('Quiz not found', 'This quiz is not available.');
      return;
    }

    renderLoading(`Loading "${item.title}"...`);

    try {
      const quiz = await loadQuiz(quizId);

      if (els.onlyWrongToggle.checked) {
        const questions = getActiveWrongQuestions({ quizIds: [quiz.id] });
        if (!questions.length) {
          renderEmpty(
            'No missed questions for this quiz',
            `There are no active missed questions in "${quiz.title}". Turn off "missed questions only" to take the full quiz.`
          );
          return;
        }

        startSession({
          id: `review:quiz:${quiz.id}`,
          type: 'review',
          title: `Misses - ${quiz.title}`,
          description: 'Review the active missed questions from the selected quiz. It does not change your overall quiz score.',
          sourceQuizId: quiz.id,
          questions,
          isOfficial: false,
          queue: []
        });
        return;
      }

      const savedProgress = hydrateSession(state.storage.quizProgress?.[quiz.id]);
      if (savedProgress?.isOfficial && savedProgress.sourceQuizId === quiz.id) {
        refreshSavedOfficialSessionMetadata(savedProgress, quiz);
        if (Object.prototype.hasOwnProperty.call(options, 'queue')) {
          savedProgress.queue = options.queue ?? [];
        }
        state.session = savedProgress;
        syncCurrentQuestionState(state.session);
        persistActiveSession();
        renderCategoryTree();
        renderQuestion();
        return;
      }

      const officialQuestions = quiz.questions.map((question) => normalizeQuestion(question, quiz, {
        isOfficialQuestion: true
      }));
      let questions = [...officialQuestions];

      if (els.includeWrongToggle.checked) {
        questions = appendActiveWrongQuestions(questions);
      }

      startSession({
        id: quiz.id,
        type: 'official',
        title: quiz.title,
        description: quiz.description ?? '',
        sourceQuizId: quiz.id,
        sourceQuizTitle: quiz.title,
        categoryId: quiz.category,
        questions,
        officialTotal: officialQuestions.length,
        isOfficial: true,
        queue: options.queue ?? []
      });
    } catch (error) {
      console.error(error);
      renderEmpty('Quiz not loaded', `I can't open "${item.title}". Check that the quiz content is available and valid.`);
    }
  }

  function refreshSavedOfficialSessionMetadata(session, quiz) {
    if (!session || !quiz) return;

    session.id = quiz.id;
    session.title = quiz.title;
    session.description = quiz.description ?? '';
    session.sourceQuizId = quiz.id;
    session.sourceQuizTitle = quiz.title;
    session.categoryId = quiz.category;
    session.sourceCategory = quiz.category;
    session.sourcePath = quiz._sourcePath;

    for (const question of session.questions ?? []) {
      if (question.sourceQuizId !== quiz.id) continue;
      question.sourceQuizTitle = quiz.title;
      question.sourceCategory = quiz.category;
      question.sourcePath = quiz._sourcePath;
    }

    for (const response of session.responses ?? []) {
      if (response.sourceQuizId === quiz.id) {
        response.sourceQuizTitle = quiz.title;
      }
    }
  }

  async function loadQuiz(quizId) {
    if (state.quizCache.has(quizId)) return state.quizCache.get(quizId);

    const item = state.itemMap.get(quizId);
    if (!item) throw new Error(`Quiz unavailable: ${quizId}`);

    const sourceQuiz = await loadQuizSource(item.path);
    const sourceQuestions = sourceQuiz.questions ?? [];
    const questions = item.sectionId
      ? sourceQuestions.filter((question) => question.section === item.sectionId)
      : sourceQuestions;

    if (!questions.length) {
      throw new Error(`Quiz section unavailable: ${quizId}`);
    }

    const normalizedQuiz = {
      ...sourceQuiz,
      id: item.id,
      title: item.title ?? sourceQuiz.title,
      description: item.description ?? sourceQuiz.description ?? '',
      category: sourceQuiz.category ?? item.categoryId,
      questions,
      _sourcePath: item.path
    };

    state.quizCache.set(quizId, normalizedQuiz);
    return normalizedQuiz;
  }

  async function loadQuizSource(path) {
    if (state.sourceCache.has(path)) return state.sourceCache.get(path);
    const quiz = await fetchJson(path);
    validateQuiz(quiz, path);
    state.sourceCache.set(path, quiz);
    return quiz;
  }

  function validateQuiz(quiz, path) {
    if (!Array.isArray(quiz.questions)) {
      throw new Error(`${path}: missing questions array`);
    }

    for (const question of quiz.questions) {
      if (!question.id || !question.text || !Array.isArray(question.answers) || !question.correct) {
        throw new Error(`${path}: incomplete question`);
      }
      const answerIds = new Set(question.answers.map((answer) => answer.id));
      if (!answerIds.has(question.correct)) {
        throw new Error(`${path}: correct answer does not exist for ${question.id}`);
      }
    }
  }

  function startSession(session) {
    persistActiveSession();

    if (!session.questions?.length) {
      renderEmpty('No questions', 'The current selection did not produce any questions.');
      return;
    }

    state.session = {
      ...session,
      questions: session.questions.map((question) => ({
        ...question,
        answers: shuffle(question.answers.map((answer) => ({ ...answer })))
      })),
      index: 0,
      selectedAnswer: null,
      confirmed: false,
      responses: [],
      selections: {},
      notice: '',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completed: false
    };

    syncCurrentQuestionState(state.session);
    persistActiveSession();
    renderCategoryTree();
    renderQuestion();
  }

  function renderQuestion() {
    const session = state.session;
    if (!session || !session.questions?.length) {
      renderWelcome();
      return;
    }

    syncCurrentQuestionState(session);
    const question = session.questions[session.index];
    const questionNumber = session.index + 1;
    const total = session.questions.length;
    const typeLabel = session.type === 'official' ? 'Quiz' : session.type === 'search' ? 'Search' : 'Missed Review';
    const sourceBadge = question.sourceQuizTitle
      ? `<span class="badge">${escapeHtml(question.sourceQuizTitle)}</span>`
      : '';
    const currentResponse = getCurrentResponse();
    const selectedAnswer = getStoredSelection(session, question, currentResponse);
    const hasSelection = Boolean(selectedAnswer);
    const isConfirmed = Boolean(currentResponse);
    const progressSummary = summarizeSessionProgress(session);
    const progressPercent = toPercent(progressSummary.answered, progressSummary.total);
    const recoveredNowBadge = isConfirmed && currentResponse.correct && question.isFromWrongBank
      ? '<span class="badge success">Removed from review</span>'
      : '';
    const wrongBadge = isActiveWrong(question.key)
      ? '<span class="badge danger">To review</span>'
      : '';
    const reviewBadge = !question.isOfficialQuestion
      ? '<span class="badge warning">Extra review</span>'
      : '';
    const noticeMarkup = session.notice
      ? `<p class="toast">${escapeHtml(session.notice)}</p>`
      : '';
    const nextLabel = getNextButtonLabel(session);
    const previousDisabled = session.index === 0 ? 'disabled' : '';

    els.quizStage.innerHTML = `
      <article class="quiz-card">
        <div class="quiz-meta">
          <span class="badge">${escapeHtml(typeLabel)}</span>
          <span class="badge warning">${session.isOfficial ? 'Progress saved' : 'Checkpoint saved'}</span>
          ${sourceBadge}
          ${wrongBadge}
          ${recoveredNowBadge}
          ${reviewBadge}
        </div>

        <h2>${escapeHtml(session.title)}</h2>
        ${session.description ? `<p class="hint">${escapeHtml(session.description)}</p>` : ''}

        <div class="progress-wrap">
          <div class="progress-top">
            <span>Question ${questionNumber} of ${total}</span>
            <span>${progressSummary.correct} correct - ${progressSummary.answered}/${progressSummary.total} answered</span>
          </div>
          <div class="progress-bar" aria-hidden="true"><span style="width:${progressPercent}%"></span></div>
        </div>

        ${noticeMarkup}
        <h3 class="question-text">${escapeHtml(question.text)}</h3>
        ${renderCodeBlock(question.code)}
        ${renderMedia(question.image, question.imageAlt)}

        <fieldset class="answers" id="answersField">
          <legend class="sr-only">Available answers</legend>
          ${question.answers.map((answer) => renderAnswerOption(answer, question, session, currentResponse)).join('')}
        </fieldset>

        ${renderFeedback(question, currentResponse)}

        <div class="quiz-actions">
          <button class="ghost-button" type="button" data-show-welcome>Exit</button>
          <button class="ghost-button" id="previousQuestionBtn" type="button" ${previousDisabled}>Previous</button>
          <button class="confirm-button" id="confirmAnswerBtn" type="button" ${hasSelection && !isConfirmed ? '' : 'disabled'} ${isConfirmed ? 'hidden' : ''}>Confirm answer</button>
          <button class="next-button" id="nextQuestionBtn" type="button">${escapeHtml(nextLabel)}</button>
        </div>
      </article>`;
  }

  function renderAnswerOption(answer, question, session, currentResponse) {
    const selectedAnswer = getStoredSelection(session, question, currentResponse);
    const isSelected = selectedAnswer === answer.id;
    const isConfirmed = Boolean(currentResponse);
    const classes = ['answer-option'];

    if (!isConfirmed && isSelected) classes.push('selected');
    if (isConfirmed && answer.id === question.correct) classes.push('correct');
    if (isConfirmed && answer.id === currentResponse.selected && !currentResponse.correct) classes.push('wrong');

    return `
      <label class="${classes.join(' ')}" data-answer-id="${escapeAttr(answer.id)}">
        <input type="radio" name="answer" value="${escapeAttr(answer.id)}" ${isSelected ? 'checked' : ''} ${isConfirmed ? 'disabled' : ''} />
        <span>${escapeHtml(answer.text)}</span>
      </label>`;
  }

  function renderFeedback(question, currentResponse) {
    if (!currentResponse) {
      return '<div class="feedback" id="feedbackBox"></div>';
    }

    return `
      <div class="feedback show ${currentResponse.correct ? 'correct' : 'wrong'}" id="feedbackBox">
        <strong>${currentResponse.correct ? 'Correct!' : 'Not quite'}</strong>
        <span>${escapeHtml(question.explanation ?? 'No explanation is available for this question.')}</span>
        ${renderCodeBlock(question.explanationCode, 'explanation-code')}
        ${renderMedia(question.explanationImage, question.explanationImageAlt)}
      </div>`;
  }

  function renderCodeBlock(code, extraClass = '') {
    if (!code) return '';
    return `<pre class="quiz-code ${escapeAttr(extraClass)}"><code>${escapeHtml(code)}</code></pre>`;
  }

  function renderMedia(src, alt = '') {
    if (!src) return '';
    return `
      <figure class="quiz-media">
        <img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" />
      </figure>`;
  }

  function getCurrentResponse() {
    const session = state.session;
    if (!session) return null;
    const question = session.questions[session.index];
    return getQuestionResponse(session, question);
  }

  function getQuestionResponse(session, question) {
    if (!session || !question) return null;
    return [...(session.responses ?? [])].reverse().find((response) => response.key === question.key) ?? null;
  }

  function getStoredSelection(session, question, response = null) {
    if (response) return response.selected;
    return session?.selections?.[question?.key] ?? null;
  }

  function syncCurrentQuestionState(session) {
    if (!session?.questions?.length) return;
    const question = session.questions[session.index];
    const response = getQuestionResponse(session, question);
    session.selections = session.selections && typeof session.selections === 'object' ? session.selections : {};
    session.selectedAnswer = getStoredSelection(session, question, response);
    session.confirmed = Boolean(response);
  }

  function getLatestResponses(session, predicate = null) {
    const responses = [];
    const seen = new Set();
    for (const response of [...(session?.responses ?? [])].reverse()) {
      if (!response?.key || seen.has(response.key)) continue;
      seen.add(response.key);
      if (!predicate || predicate(response)) {
        responses.push(response);
      }
    }
    return responses.reverse();
  }

  function summarizeSessionProgress(session) {
    if (!session) return { answered: 0, correct: 0, total: 0 };
    const officialQuestionKeys = new Set((session.questions ?? [])
      .filter((question) => question.isOfficialQuestion)
      .map((question) => question.key));
    const responses = getLatestResponses(session, (response) => (
      session.isOfficial
        ? Boolean(response.isOfficialQuestion) && officialQuestionKeys.has(response.key)
        : true
    ));
    const total = session.isOfficial
      ? Number(session.officialTotal ?? officialQuestionKeys.size)
      : session.questions?.length ?? 0;

    return {
      answered: responses.length,
      correct: responses.filter((response) => response.correct).length,
      total
    };
  }

  function getStoredQuizProgressSummary(quizId) {
    const session = hydrateSession(state.storage.quizProgress?.[quizId]);
    if (!session?.isOfficial || session.sourceQuizId !== quizId) return null;
    return summarizeSessionProgress(session);
  }

  function getNextButtonLabel(session) {
    if (!session) return 'Next';
    if (session.index < session.questions.length - 1) return 'Next';
    if (session.isOfficial && getSkippedOfficialQuestionIndexes(session).length) return 'Review skipped';
    return 'Finish session';
  }

  function getSkippedOfficialQuestionIndexes(session) {
    if (!session?.isOfficial) return [];
    const answeredKeys = new Set(getLatestResponses(session, (response) => response.isOfficialQuestion).map((response) => response.key));
    return (session.questions ?? [])
      .map((question, index) => ({ question, index }))
      .filter(({ question }) => question.isOfficialQuestion && !answeredKeys.has(question.key))
      .map(({ index }) => index);
  }

  function selectAnswer(answerId) {
    if (!state.session) return;
    const question = state.session.questions[state.session.index];
    if (getQuestionResponse(state.session, question)) return;

    state.session.selections = state.session.selections && typeof state.session.selections === 'object' ? state.session.selections : {};
    state.session.selections[question.key] = answerId;
    state.session.selectedAnswer = answerId;
    state.session.confirmed = false;
    state.session.notice = '';
    persistActiveSession();

    document.querySelectorAll('.answer-option').forEach((label) => {
      label.classList.toggle('selected', label.dataset.answerId === answerId);
      const input = label.querySelector('input');
      if (input) input.checked = label.dataset.answerId === answerId;
    });

    const confirmButton = document.getElementById('confirmAnswerBtn');
    if (confirmButton) confirmButton.disabled = false;
  }

  function confirmAnswer() {
    const session = state.session;
    if (!session) return;

    const question = session.questions[session.index];
    if (getQuestionResponse(session, question)) return;

    const selected = session.selections?.[question.key] ?? session.selectedAnswer;
    if (!selected) return;

    const isCorrectAnswer = selected === question.correct;

    session.confirmed = true;
    session.selectedAnswer = selected;
    session.notice = '';
    session.responses.push({
      key: question.key,
      questionId: question.id,
      questionText: question.text,
      sourceQuizId: question.sourceQuizId,
      sourceQuizTitle: question.sourceQuizTitle,
      selected,
      correctAnswer: question.correct,
      correct: isCorrectAnswer,
      isOfficialQuestion: Boolean(question.isOfficialQuestion),
      answeredAt: new Date().toISOString()
    });

    recordQuestionOutcome(question, isCorrectAnswer, selected);
    persistActiveSession();
    renderStats();
    renderCategoryTree();
    renderQuestion();
  }

  function goToNextQuestion() {
    const session = state.session;
    if (!session) return;

    if (session.index < session.questions.length - 1) {
      session.index += 1;
      session.notice = '';
      syncCurrentQuestionState(session);
      persistActiveSession();
      renderQuestion();
      return;
    }

    const skippedIndexes = getSkippedOfficialQuestionIndexes(session);
    if (skippedIndexes.length) {
      session.index = skippedIndexes[0];
      session.notice = `Answer ${skippedIndexes.length === 1 ? 'the skipped question' : `${skippedIndexes.length} skipped questions`} to finish this quiz.`;
      syncCurrentQuestionState(session);
      persistActiveSession();
      renderQuestion();
      return;
    }

    finishSession();
  }

  function goToPreviousQuestion() {
    const session = state.session;
    if (!session || session.index <= 0) return;

    session.index -= 1;
    session.notice = '';
    syncCurrentQuestionState(session);
    persistActiveSession();
    renderQuestion();
  }

  function finishSession() {
    const session = state.session;
    if (!session) return;

    const skippedIndexes = getSkippedOfficialQuestionIndexes(session);
    if (skippedIndexes.length) {
      session.index = skippedIndexes[0];
      session.notice = `Answer ${skippedIndexes.length === 1 ? 'the skipped question' : `${skippedIndexes.length} skipped questions`} to finish this quiz.`;
      syncCurrentQuestionState(session);
      persistActiveSession();
      renderQuestion();
      return;
    }

    const latestResponses = getLatestResponses(session);
    const total = latestResponses.length;
    const correct = latestResponses.filter((response) => response.correct).length;
    const officialResponses = getLatestResponses(session, (response) => response.isOfficialQuestion);
    const officialCorrect = officialResponses.filter((response) => response.correct).length;
    const officialTotal = session.isOfficial
      ? Number(session.officialTotal ?? session.questions.filter((question) => question.isOfficialQuestion).length)
      : officialResponses.length;

    let savedResult = null;
    if (session.isOfficial && officialTotal > 0) {
      savedResult = saveOfficialResult(session, officialCorrect, officialTotal);
    }

    const wrongResponses = latestResponses.filter((response) => !response.correct);
    const scorePercent = toPercent(correct, total);
    const officialPercent = officialTotal ? toPercent(officialCorrect, officialTotal) : null;
    const hasQueue = session.queue?.length > 0;
    const currentQuizMisses = session.sourceQuizId ? getActiveWrongCount({ quizId: session.sourceQuizId }) : 0;

    session.completed = true;
    state.storage.activeSession = null;
    if (session.isOfficial && session.sourceQuizId) {
      delete state.storage.quizProgress[session.sourceQuizId];
    }
    saveStorage();
    renderStats();
    renderCategoryTree();

    els.quizStage.innerHTML = `
      <article class="result-card">
        <p class="eyebrow">Session Complete</p>
        <h2>${escapeHtml(session.title)}</h2>
        <p>
          ${session.isOfficial
            ? 'This result was saved and contributes to your overall score.'
            : 'This search/review session tracks missed questions, but does not change your overall quiz score.'}
        </p>

        <div class="result-grid">
          <div class="result-mini">
            <span>Session score</span>
            <strong>${correct}/${total}</strong>
            <small>${scorePercent}%</small>
          </div>
          <div class="result-mini">
            <span>${session.isOfficial ? 'Quiz score' : 'Active misses remaining'}</span>
            <strong>${session.isOfficial ? `${officialCorrect}/${officialTotal}` : getActiveWrongCount()}</strong>
            <small>${session.isOfficial ? `${officialPercent}% - best: ${savedResult.bestCorrect}/${savedResult.total}` : 'questions still queued for review'}</small>
          </div>
        </div>

        ${wrongResponses.length ? renderWrongReviewList(wrongResponses) : '<p class="toast">Perfect: no missed answers in this session.</p>'}

        <div class="quiz-actions">
          <button class="ghost-button" type="button" data-show-welcome>Back to selection</button>
          ${session.sourceQuizId ? `<button class="primary-button" type="button" data-start-quiz="${escapeAttr(session.sourceQuizId)}">Retake this quiz</button>` : ''}
          ${session.isOfficial && currentQuizMisses ? `<button class="secondary-button" type="button" data-review-current-wrong="${escapeAttr(session.sourceQuizId)}">Review missed questions now</button>` : ''}
          ${hasQueue ? '<button class="next-button" type="button" data-continue-queue>Continue to next quiz</button>' : ''}
        </div>
      </article>`;
  }

  function renderWrongReviewList(wrongResponses) {
    return `
      <div class="review-list">
        <p class="toast">Questions marked for review:</p>
        ${wrongResponses.map((response) => `
          <div class="review-item">
            <strong>${escapeHtml(response.questionText)}</strong>
            <small>${escapeHtml(response.sourceQuizTitle ?? 'Unknown quiz')}</small>
          </div>`).join('')}
      </div>`;
  }

  function saveOfficialResult(session, correct, total) {
    const previous = state.storage.results[session.sourceQuizId] ?? null;
    const bestCorrect = Math.max(previous?.bestCorrect ?? 0, correct);
    const attempts = (previous?.attempts ?? 0) + 1;

    const result = {
      quizId: session.sourceQuizId,
      title: session.sourceQuizTitle ?? session.title,
      total,
      lastCorrect: correct,
      lastPercent: toPercent(correct, total),
      bestCorrect,
      bestPercent: toPercent(bestCorrect, total),
      attempts,
      lastCompletedAt: new Date().toISOString()
    };

    state.storage.results[session.sourceQuizId] = result;
    return result;
  }

  function recordQuestionOutcome(question, isCorrectAnswer, selectedAnswerId) {
    const key = question.key;
    if (!key || !question.sourceQuizId) return;

    ensureRecoveredStore();

    const previous = state.storage.wrong[key];
    const now = new Date().toISOString();

    if (!isCorrectAnswer) {
      state.storage.wrong[key] = {
        key,
        quizId: question.sourceQuizId,
        quizTitle: question.sourceQuizTitle,
        category: question.sourceCategory,
        status: 'toReview',
        wrongCount: (previous?.wrongCount ?? 0) + 1,
        correctStreak: 0,
        lastSelected: selectedAnswerId,
        lastWrongAt: now,
        question: snapshotQuestion(question)
      };
      delete state.storage.recovered[key];
      return;
    }

    if (!previous) return;

    const correctStreak = (previous.correctStreak ?? 0) + 1;
    const shouldRemoveFromWrongList = Boolean(question.isFromWrongBank) || correctStreak >= 2;

    if (shouldRemoveFromWrongList) {
      archiveRecoveredQuestion(key, {
        ...previous,
        status: 'recovered',
        correctStreak,
        lastCorrectAt: now,
        recoveredAt: now,
        recoveredFromWrongBank: Boolean(question.isFromWrongBank),
        question: previous.question ?? snapshotQuestion(question)
      });
      delete state.storage.wrong[key];
      return;
    }

    state.storage.wrong[key] = {
      ...previous,
      correctStreak,
      status: 'toReview',
      lastCorrectAt: now,
      question: previous.question ?? snapshotQuestion(question)
    };
  }

  function ensureRecoveredStore() {
    if (!state.storage.recovered || typeof state.storage.recovered !== 'object') {
      state.storage.recovered = {};
    }
  }

  function archiveRecoveredQuestion(key, record) {
    ensureRecoveredStore();
    state.storage.recovered[key] = record;
  }

  function snapshotQuestion(question) {
    return {
      id: question.id,
      text: question.text,
      code: question.code ?? '',
      image: question.image ?? '',
      imageAlt: question.imageAlt ?? '',
      answers: question.answers.map((answer) => ({ id: answer.id, text: answer.text })),
      correct: question.correct,
      explanation: question.explanation ?? '',
      explanationCode: question.explanationCode ?? '',
      explanationImage: question.explanationImage ?? '',
      explanationImageAlt: question.explanationImageAlt ?? '',
      tags: question.tags ?? []
    };
  }

  function normalizeQuestion(question, quiz, options = {}) {
    const key = `${quiz.id}::${question.id}`;
    return {
      ...question,
      key,
      sourceQuizId: quiz.id,
      sourceQuizTitle: quiz.title,
      sourceCategory: quiz.category,
      sourcePath: quiz._sourcePath,
      isOfficialQuestion: Boolean(options.isOfficialQuestion),
      isFromWrongBank: Boolean(options.isFromWrongBank)
    };
  }

  function questionFromWrongRecord(record) {
    const question = record.question;
    return {
      ...question,
      key: record.key,
      sourceQuizId: record.quizId,
      sourceQuizTitle: record.quizTitle,
      sourceCategory: record.category,
      isOfficialQuestion: false,
      isFromWrongBank: true
    };
  }

  function appendActiveWrongQuestions(questions) {
    const seen = new Set(questions.map((question) => question.key));
    const extras = getActiveWrongQuestions()
      .filter((question) => !seen.has(question.key))
      .map((question) => ({ ...question, isOfficialQuestion: false }));

    return [...questions, ...extras];
  }

  function getActiveWrongQuestions(filter = {}) {
    return Object.values(state.storage.wrong)
      .filter((record) => record.status !== 'mastered' && record.status !== 'recovered')
      .filter((record) => {
        if (filter.quizId) return record.quizId === filter.quizId;
        if (filter.quizIds) return filter.quizIds.includes(record.quizId);
        return true;
      })
      .map(questionFromWrongRecord);
  }

  function getActiveWrongCount(filter = {}) {
    return getActiveWrongQuestions(filter).length;
  }

  function isActiveWrong(key) {
    const record = state.storage.wrong[key];
    return Boolean(record && record.status !== 'mastered' && record.status !== 'recovered');
  }

  function startMissedReviewForQuiz(quizId, options = {}) {
    const questions = getActiveWrongQuestions({ quizId });
    const item = state.itemMap.get(quizId);
    const title = item?.title ?? questions[0]?.sourceQuizTitle ?? 'Selected quiz';

    if (!questions.length) {
      renderEmpty('No active misses', `There are no active missed questions in "${title}".`);
      return;
    }

    startSession({
      id: `review:quiz:${quizId}`,
      type: 'review',
      title: `Misses - ${title}`,
      description: 'Answer these missed questions correctly to remove them from review.',
      sourceQuizId: quizId,
      questions,
      isOfficial: false,
      queue: options.queue ?? []
    });
  }

  async function handleSearch(event) {
    event.preventDefault();
    const term = normalizeText(els.searchInput.value.trim());

    if (!term) {
      renderEmpty('Enter a search term', 'Examples: "for", "pointers", "vector", "preprocessor".');
      return;
    }

    renderLoading(`Searching all quizzes for "${term}"...`);

    try {
      const quizzes = await loadAllQuizzes();
      const matches = [];

      for (const quiz of quizzes) {
        for (const question of quiz.questions) {
          if (questionMatches(question, quiz, term)) {
            matches.push(normalizeQuestion(question, quiz, { isOfficialQuestion: false }));
          }
        }
      }

      if (!matches.length) {
        renderEmpty(
          'No results',
          `No questions matched "${term}". Try a concept, keyword, or tag from the quiz content.`
        );
        return;
      }

      startSession({
        id: `search:${term}`,
        type: 'search',
        title: `Search - "${term}"`,
        description: `${matches.length} questions found across ${quizzes.length} quizzes. This session does not count toward your overall score.`,
        questions: matches,
        isOfficial: false,
        queue: []
      });
    } catch (error) {
      console.error(error);
      renderEmpty('Search unavailable', "I can't load all quiz content right now. Check the local server and try again.");
    }
  }

  async function loadAllQuizzes() {
    const quizIds = Array.from(state.itemMap.keys());
    const quizzes = [];
    for (const quizId of quizIds) {
      quizzes.push(await loadQuiz(quizId));
    }
    return quizzes;
  }

  function questionMatches(question, quiz, term) {
    const tags = (question.tags ?? []).map(normalizeText);
    if (tags.includes(term)) return true;

    const textPool = normalizeText([
      question.text,
      question.code,
      question.explanation,
      question.explanationCode,
      quiz.title,
      quiz.description,
      quiz.category,
      ...(question.answers ?? []).map((answer) => answer.text),
      ...tags
    ].filter(Boolean).join(' '));

    if (term.length <= 3) {
      const tokens = textPool.split(/[^a-z0-9_+#]+/i).filter(Boolean);
      return tokens.includes(term);
    }

    return textPool.includes(term);
  }

  function renderLoading(message) {
    els.quizStage.innerHTML = `
      <div class="welcome-card">
        <p class="eyebrow">Loading</p>
        <h2>${escapeHtml(message)}</h2>
        <p class="hint">Questions are loaded from the available quiz content.</p>
      </div>`;
  }

  function renderEmpty(title, message) {
    els.quizStage.innerHTML = `
      <div class="welcome-card">
        <p class="eyebrow">Info</p>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <button type="button" class="ghost-button" data-show-welcome>Back to selection</button>
      </div>`;
  }

  function renderStats() {
    const stats = calculateStats();

    els.overallScore.textContent = `${stats.overallPercent}%`;
    els.overallDetail.textContent = stats.totalQuestions
      ? `${stats.totalBestCorrect}/${stats.totalQuestions} best score across completed quizzes`
      : 'No completed quizzes';
    els.completedCount.textContent = String(stats.completedCount);
    els.wrongCount.textContent = String(stats.activeWrong);
    els.wrongDetail.textContent = `${stats.masteredWrong} recovered`;
  }

  function calculateStats() {
    const results = Object.values(state.storage.results ?? {});
    const totalQuestions = results.reduce((sum, result) => sum + result.total, 0);
    const totalBestCorrect = results.reduce((sum, result) => sum + result.bestCorrect, 0);
    const activeWrong = Object.values(state.storage.wrong ?? {}).filter((record) => record.status !== 'mastered' && record.status !== 'recovered').length;
    const masteredWrong = Object.keys(state.storage.recovered ?? {}).length
      + Object.values(state.storage.wrong ?? {}).filter((record) => record.status === 'mastered' || record.status === 'recovered').length;

    return {
      overallPercent: toPercent(totalBestCorrect, totalQuestions),
      totalQuestions,
      totalBestCorrect,
      completedCount: results.length,
      activeWrong,
      masteredWrong,
      updatedAt: new Date().toISOString()
    };
  }

  function restorePreferences() {
    els.includeWrongToggle.checked = Boolean(state.storage.preferences?.includeWrong);
    els.onlyWrongToggle.checked = Boolean(state.storage.preferences?.onlyWrong);
  }

  function savePreferencesFromControls() {
    state.storage.preferences = {
      includeWrong: els.includeWrongToggle.checked,
      onlyWrong: els.onlyWrongToggle.checked
    };
    saveStorage();
  }

  function hasResumableSession() {
    return Boolean(hydrateSession(state.storage.activeSession));
  }

  function resumeActiveSession() {
    const session = hydrateSession(state.storage.activeSession);
    if (!session) {
      state.storage.activeSession = null;
      state.session = null;
      saveStorage();
      renderWelcome();
      return;
    }

    state.session = session;
    persistActiveSession();
    renderCategoryTree();
    renderQuestion();
  }

  function discardActiveSession() {
    state.session = null;
    state.storage.activeSession = null;
    saveStorage();
    renderCategoryTree();
    renderWelcome();
  }

  function persistActiveSession() {
    if (!isSessionCheckpointable(state.session)) return;
    state.session.updatedAt = new Date().toISOString();
    if (state.session.isOfficial && state.session.sourceQuizId) {
      state.storage.quizProgress = state.storage.quizProgress && typeof state.storage.quizProgress === 'object'
        ? state.storage.quizProgress
        : {};
      state.storage.quizProgress[state.session.sourceQuizId] = serializeSession(state.session);
      state.storage.activeSession = null;
    } else {
      state.storage.activeSession = serializeSession(state.session);
    }
    saveStorage();
  }

  function serializeSession(session) {
    return JSON.parse(JSON.stringify(session));
  }

  function isSessionCheckpointable(session) {
    return Boolean(session && !session.completed && Array.isArray(session.questions) && session.questions.length);
  }

  function hydrateSession(rawSession) {
    if (!rawSession || typeof rawSession !== 'object' || rawSession.completed) return null;

    const session = JSON.parse(JSON.stringify(rawSession));
    if (!Array.isArray(session.questions) || !session.questions.length) return null;

    const index = Number.isInteger(session.index) ? session.index : 0;
    if (index < 0 || index >= session.questions.length) return null;

    session.id = session.id ?? 'session:unknown';
    session.type = session.type ?? 'official';
    session.title = session.title ?? 'Active quiz';
    session.description = session.description ?? '';
    session.index = index;
    session.selectedAnswer = session.selectedAnswer ?? null;
    session.confirmed = Boolean(session.confirmed);
    session.responses = Array.isArray(session.responses) ? session.responses : [];
    session.selections = session.selections && typeof session.selections === 'object' ? session.selections : {};
    session.notice = session.notice ?? '';
    session.queue = Array.isArray(session.queue) ? session.queue : [];
    session.isOfficial = Boolean(session.isOfficial);
    session.questions = session.questions.map((question) => ({
      ...question,
      answers: Array.isArray(question.answers) ? question.answers.map((answer) => ({ ...answer })) : []
    }));

    const currentQuestion = session.questions[session.index];
    if (!currentQuestion || !Array.isArray(currentQuestion.answers) || !currentQuestion.correct) return null;
    if (session.confirmed) {
      const hasCurrentResponse = session.responses.some((response) => response.key === currentQuestion.key);
      if (!hasCurrentResponse) session.confirmed = false;
    }
    syncCurrentQuestionState(session);

    return session;
  }

  function loadStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return makeEmptyStorage();
      const parsed = JSON.parse(raw);
      const empty = makeEmptyStorage();
      const storedVersion = Number(parsed.version ?? 0);
      const hasLegacyQuestionSnapshots = storedVersion < 4;

      const migrated = hasLegacyQuestionSnapshots
        ? { wrong: {}, recovered: {} }
        : migrateStoredWrongRecords(parsed.wrong ?? {}, parsed.recovered ?? {});

      const results = migrateStoredResults(parsed.results ?? {});
      const quizProgress = migrateStoredQuizProgress(parsed.quizProgress ?? {});
      const migratedActiveSession = migrateStoredSessionReferences(parsed.activeSession ?? null);
      const activeSession = shouldDiscardStoredSession(migratedActiveSession, storedVersion) ? null : migratedActiveSession ?? null;
      const hydratedActiveSession = hydrateSession(activeSession);
      const activeSessionIsOfficial = Boolean(hydratedActiveSession?.isOfficial && hydratedActiveSession.sourceQuizId);
      if (activeSessionIsOfficial) {
        quizProgress[hydratedActiveSession.sourceQuizId] = serializeSession(hydratedActiveSession);
      }

      return {
        ...empty,
        version: STORAGE_VERSION,
        results,
        wrong: migrated.wrong,
        recovered: migrated.recovered,
        quizProgress,
        activeSession: activeSessionIsOfficial ? null : activeSession,
        preferences: {
          ...empty.preferences,
          ...(parsed.preferences ?? {})
        },
        stats: parsed.stats ?? null
      };
    } catch (error) {
      console.warn('Progress data is unreadable; starting over.', error);
      return makeEmptyStorage();
    }
  }

  function migrateStoredWrongRecords(wrongRecords = {}, recoveredRecords = {}) {
    const wrong = {};
    const recovered = {};

    for (const [key, record] of Object.entries(recoveredRecords ?? {})) {
      const migratedRecord = migrateStoredWrongRecord(record, key);
      recovered[migratedRecord.key] = migratedRecord;
    }

    for (const [key, record] of Object.entries(wrongRecords)) {
      const migratedRecord = migrateStoredWrongRecord(record, key);
      if (migratedRecord?.status === 'mastered' || migratedRecord?.status === 'recovered') {
        recovered[migratedRecord.key] = {
          ...migratedRecord,
          status: 'recovered',
          recoveredAt: migratedRecord.recoveredAt ?? migratedRecord.masteredAt ?? migratedRecord.lastCorrectAt ?? new Date().toISOString()
        };
      } else {
        wrong[migratedRecord.key] = migratedRecord;
      }
    }

    return { wrong, recovered };
  }

  function migrateStoredQuizProgress(progressRecords = {}) {
    const quizProgress = {};

    for (const rawSession of Object.values(progressRecords ?? {})) {
      const migratedSession = migrateStoredSessionReferences(rawSession);
      if (shouldDiscardStoredSession(migratedSession, STORAGE_VERSION)) continue;
      const session = hydrateSession(migratedSession);
      if (!session?.isOfficial || !session.sourceQuizId || session.completed) continue;
      quizProgress[session.sourceQuizId] = serializeSession(session);
    }

    return quizProgress;
  }

  function migrateStoredResults(resultRecords = {}) {
    const results = {};

    for (const [quizId, result] of Object.entries(resultRecords ?? {})) {
      const migratedQuizId = migrateStoredReference(quizId);
      const migratedResult = {
        ...(result ?? {}),
        quizId: migrateStoredReference(result?.quizId ?? migratedQuizId)
      };
      results[migratedQuizId] = mergeStoredResults(results[migratedQuizId], migratedResult);
    }

    return results;
  }

  function mergeStoredResults(existing, incoming) {
    if (!existing) return incoming;

    const existingTime = Date.parse(existing.lastCompletedAt ?? '');
    const incomingTime = Date.parse(incoming.lastCompletedAt ?? '');
    const latest = Number.isFinite(incomingTime) && (!Number.isFinite(existingTime) || incomingTime >= existingTime)
      ? incoming
      : existing;
    const total = latest.total ?? incoming.total ?? existing.total ?? 0;
    const bestCorrect = Math.max(existing.bestCorrect ?? 0, incoming.bestCorrect ?? 0);

    return {
      ...existing,
      ...latest,
      total,
      bestCorrect,
      bestPercent: toPercent(bestCorrect, total),
      attempts: (existing.attempts ?? 0) + (incoming.attempts ?? 0)
    };
  }

  function migrateStoredWrongRecord(record, fallbackKey) {
    const key = migrateStoredReference(record?.key ?? fallbackKey);
    return {
      ...(record ?? {}),
      key,
      quizId: migrateStoredReference(record?.quizId),
      category: migrateStoredReference(record?.category),
      question: record?.question ? migrateStoredQuestionReference(record.question) : record?.question
    };
  }

  function migrateStoredSessionReferences(rawSession) {
    if (!rawSession || typeof rawSession !== 'object') return rawSession;

    const session = JSON.parse(JSON.stringify(rawSession));
    session.id = migrateStoredReference(session.id);
    session.sourceQuizId = migrateStoredReference(session.sourceQuizId);
    session.categoryId = migrateStoredReference(session.categoryId);
    session.sourceCategory = migrateStoredReference(session.sourceCategory);
    session.sourcePath = migrateStoredReference(session.sourcePath);

    if (Array.isArray(session.queue)) {
      session.queue = session.queue.map(migrateStoredReference);
    }

    if (Array.isArray(session.questions)) {
      session.questions = session.questions.map(migrateStoredQuestionReference);
    }

    if (Array.isArray(session.responses)) {
      session.responses = session.responses.map(migrateStoredResponseReference);
    }

    session.selections = migrateStoredSelectionMap(session.selections);
    return session;
  }

  function migrateStoredQuestionReference(question) {
    if (!question || typeof question !== 'object') return question;
    return {
      ...question,
      key: migrateStoredReference(question.key),
      sourceQuizId: migrateStoredReference(question.sourceQuizId),
      sourceCategory: migrateStoredReference(question.sourceCategory),
      sourcePath: migrateStoredReference(question.sourcePath)
    };
  }

  function migrateStoredResponseReference(response) {
    if (!response || typeof response !== 'object') return response;
    return {
      ...response,
      key: migrateStoredReference(response.key),
      sourceQuizId: migrateStoredReference(response.sourceQuizId)
    };
  }

  function migrateStoredSelectionMap(selections) {
    if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return selections;

    const migratedSelections = {};
    for (const [key, value] of Object.entries(selections)) {
      migratedSelections[migrateStoredReference(key)] = value;
    }
    return migratedSelections;
  }

  function migrateStoredReference(value) {
    return value;
  }

  function shouldDiscardStoredSession(session, storedVersion) {
    if (storedVersion < 4) return true;
    if (!session || typeof session !== 'object') return false;
    return false;
  }

  function makeEmptyStorage() {
    return {
      version: STORAGE_VERSION,
      results: {},
      wrong: {},
      recovered: {},
      quizProgress: {},
      activeSession: null,
      preferences: {
        includeWrong: false,
        onlyWrong: false
      },
      stats: null
    };
  }

  function saveStorage() {
    state.storage.version = STORAGE_VERSION;
    state.storage.quizProgress = state.storage.quizProgress && typeof state.storage.quizProgress === 'object'
      ? state.storage.quizProgress
      : {};
    state.storage.stats = calculateStats();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.storage));
  }

  function toPercent(correct, total) {
    if (!total) return 0;
    return Math.round((correct / total) * 100);
  }

  function shuffle(items) {
    return items
      .map((item) => ({ item, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ item }) => item);
  }

  function normalizeText(value) {
    return String(value ?? '')
      .toLocaleLowerCase('en-US')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
