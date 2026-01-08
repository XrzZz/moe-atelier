import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { Layout, Button, Form, Input, Switch, Row, Col, Typography, Space, ConfigProvider, Drawer, AutoComplete, Radio, message, Tooltip, Select, Divider, Collapse, Slider } from 'antd';
import { 
  PlusOutlined, 
  SettingFilled, 
  ThunderboltFilled, 
  CheckCircleFilled, 
  ApiFilled, 
  HeartFilled,
  AppstoreFilled,
  ExperimentFilled,
  SafetyCertificateFilled,
  ReloadOutlined,
  DeleteFilled,
  KeyOutlined
} from '@ant-design/icons';
import {
  DndContext, 
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  defaultDropAnimationSideEffects,
  DropAnimation
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
  defaultAnimateLayoutChanges,
  AnimateLayoutChanges
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { v4 as uuidv4 } from 'uuid';
import ImageTask from './components/ImageTask';
import PromptDrawer from './components/PromptDrawer';
import CollectionBox from './components/CollectionBox';
import type { AppConfig, TaskConfig } from './types/app';
import type { CollectionItem } from './types/collection';
import type { GlobalStats } from './types/stats';
import type { PersistedUploadImage } from './types/imageTask';
import {
  cleanupTaskCache,
  cleanupUnusedImageCache,
  collectTaskImageKeys,
  deleteImageCache,
  getTaskStorageKey,
  loadCollectionItems,
  loadConfig,
  loadFormatConfig,
  loadGlobalStats,
  loadTasks,
  saveConfig,
  saveCollectionItems,
  STORAGE_KEYS,
} from './app/storage';
import {
  type ApiFormat,
  API_VERSION_OPTIONS,
  DEFAULT_API_BASES,
  extractVertexProjectId,
  inferApiVersionFromUrl,
  normalizeApiBase,
  resolveApiUrl,
  resolveApiVersion,
} from './utils/apiUrl';
import { safeStorageSet } from './utils/storage';
import { calculateSuccessRate, formatDuration } from './utils/stats';
import { TASK_STATE_VERSION, saveTaskState, DEFAULT_TASK_STATS } from './components/imageTaskState';
import {
  authBackend,
  clearBackendToken,
  deleteBackendTask,
  fetchBackendCollection,
  fetchBackendState,
  getBackendMode,
  getBackendToken,
  buildBackendStreamUrl,
  patchBackendState,
  putBackendTask,
  putBackendCollection,
  setBackendMode as persistBackendMode,
  setBackendToken,
} from './utils/backendApi';

const { Header, Content } = Layout;
const { Title, Text } = Typography;
const EMPTY_GLOBAL_STATS: GlobalStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};
const IMAGE_SIZE_OPTIONS = ['1K', '2K', '4K'];
const ASPECT_RATIO_OPTIONS = [
  'auto',
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '2:3',
  '3:2',
  '4:5',
  '5:4',
];
const SAFETY_OPTIONS = [
  { label: 'OFF', value: 'OFF' },
  { label: 'BLOCK_NONE', value: 'BLOCK_NONE' },
  { label: 'BLOCK_ONLY_HIGH', value: 'BLOCK_ONLY_HIGH' },
  { label: 'BLOCK_MEDIUM', value: 'BLOCK_MEDIUM_AND_ABOVE' },
  { label: 'BLOCK_LOW', value: 'BLOCK_LOW_AND_ABOVE' },
];

interface SortableTaskItemProps {
  task: TaskConfig;
  config: AppConfig;
  backendMode: boolean;
  onRemove: (id: string) => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
  onCollect: (item: CollectionItem) => void;
  collectionRevision: number;
}

const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true });

interface LazySliderProps {
  value?: number;
  onChange?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}

const LazySliderInput: React.FC<LazySliderProps> = ({ value = 0, onChange, min, max, step = 1 }) => {
  const [localValue, setLocalValue] = useState<number>(value);
  
  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleSliderChange = (val: number) => {
    setLocalValue(val);
  };

  const handleSliderAfterChange = (val: number) => {
    onChange?.(val);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === '') return;
    if (!/^\d+$/.test(val)) return;
    setLocalValue(Number(val));
  };

  const handleInputBlur = () => {
    let constrained = Math.max(min, Math.min(max, localValue));
    if (step) {
      constrained = Math.round(constrained / step) * step;
    }
    setLocalValue(constrained);
    onChange?.(constrained);
  };

  return (
    <Row gutter={12} align="middle">
      <Col span={16}>
        <Slider
          min={min}
          max={max}
          step={step}
          value={localValue}
          onChange={handleSliderChange}
          onAfterChange={handleSliderAfterChange}
        />
      </Col>
      <Col span={8}>
        <div style={{ 
          background: '#fff', 
          padding: '2px 8px', 
          borderRadius: 12, 
          display: 'flex', 
          alignItems: 'center',
          height: 28,
          justifyContent: 'center'
        }}>
          <input 
            type="number"
            value={localValue}
            onChange={handleInputChange} 
            onBlur={handleInputBlur}
            style={{ 
              width: '100%', 
              border: 'none', 
              textAlign: 'center', 
              color: '#665555', 
              fontWeight: 700,
              background: 'transparent',
              outline: 'none',
              fontSize: 12,
              padding: 0,
            }}
          />
        </div>
      </Col>
    </Row>
  );
};

const SortableTaskItem = ({ task, config, backendMode, onRemove, onStatsUpdate, onCollect, collectionRevision }: SortableTaskItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ 
    id: task.id,
    animateLayoutChanges
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 999 : 'auto',
    opacity: isDragging ? 0 : 1,
  };

  return (
    <Col 
      id={task.id}
      xs={24} sm={12} xl={8} 
      ref={setNodeRef} 
      style={style}
    >
      <div className="fade-in-up" style={{ height: '100%' }}>
        <ImageTask
          id={task.id}
          storageKey={getTaskStorageKey(task.id)}
          config={config}
          backendMode={backendMode}
          onRemove={() => onRemove(task.id)}
          onStatsUpdate={onStatsUpdate}
          onCollect={onCollect}
          collectionRevision={collectionRevision}
          dragAttributes={attributes}
          dragListeners={listeners}
        />
      </div>
    </Col>
  );
};

function App() {
  const initialBackendMode = getBackendMode() && Boolean(getBackendToken());
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [tasks, setTasks] = useState<TaskConfig[]>(() =>
    initialBackendMode ? [] : loadTasks(),
  );
  const [globalStats, setGlobalStats] = useState<GlobalStats>(() => loadGlobalStats());
  const [configVisible, setConfigVisible] = useState(false);
  const [collectionVisible, setCollectionVisible] = useState(false);
  const [collectedItems, setCollectedItems] = useState<CollectionItem[]>(() =>
    initialBackendMode ? [] : loadCollectionItems(),
  );
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [promptDrawerVisible, setPromptDrawerVisible] = useState(false);
  const [models, setModels] = useState<{label: string, value: string}[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeItemWidth, setActiveItemWidth] = useState<number | undefined>(undefined);
  const [form] = Form.useForm();
  const [backendMode, setBackendModeState] = useState<boolean>(() => initialBackendMode);
  const [backendAuthPending, setBackendAuthPending] = useState(false);
  const [backendPassword, setBackendPassword] = useState('');
  const [backendAuthLoading, setBackendAuthLoading] = useState(false);
  const [backendSyncing, setBackendSyncing] = useState(false);
  const backendModeRef = useRef(initialBackendMode);
  const localHydratingRef = useRef(false);
  const backendApplyingRef = useRef(false);
  const backendBootstrappedRef = useRef(false);
  const backendReadyRef = useRef(false);
  const backendCollectionHydratingRef = useRef(false);
  const backendCollectionSyncTimerRef = useRef<number | null>(null);
  const backendCollectionLastPayloadRef = useRef<string>('');
  const collectedItemsRef = useRef(collectedItems);
  const collectionCountRef = useRef(collectedItems.length);

  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);
    const node = document.getElementById(active.id as string);
    if (node) {
      // 获取内部内容容器的宽度，排除 Col 的 padding 影响
      const innerContent = node.querySelector('.fade-in-up') as HTMLElement;
      if (innerContent) {
        setActiveItemWidth(innerContent.offsetWidth);
      } else {
        setActiveItemWidth(node.offsetWidth);
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveItemWidth(undefined);

    if (active.id !== over?.id) {
      setTasks((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over?.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setActiveItemWidth(undefined);
  };

  const dropAnimation: DropAnimation = {
    duration: 300,
    easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
    sideEffects: (args) => {
      const { dragOverlay } = args;
      const defaultFn = defaultDropAnimationSideEffects({
        styles: {
          active: {
            opacity: '0',
          },
        },
      });
      const cleanup = defaultFn(args);

      const inner = dragOverlay.node.querySelector('.drag-overlay-item');
      if (inner) {
        inner.animate(
          [
            { transform: 'scale(1.02)' },
            { transform: 'scale(1)' }
          ],
          {
            duration: 300,
            easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
            fill: 'forwards'
          }
        );
      }
      return cleanup;
    },
  };

  const applyBackendState = useCallback(
    (state: { config: AppConfig; tasksOrder: string[]; globalStats: GlobalStats }) => {
      if (!backendModeRef.current) return;
      backendApplyingRef.current = true;
      backendReadyRef.current = true;
      if (state?.config) {
        setConfig(state.config);
      }
      const order = Array.isArray(state?.tasksOrder) ? state.tasksOrder : [];
      setTasks(order.map((id) => ({ id, prompt: '' })));
      if (state?.globalStats) {
        setGlobalStats(state.globalStats);
      }
      window.setTimeout(() => {
        backendApplyingRef.current = false;
      }, 200);
    },
    [form],
  );

  const bootstrapBackendState = useCallback(async () => {
    setBackendSyncing(true);
    try {
      const state = await fetchBackendState();
      if (!backendModeRef.current) return;
      if (state.tasksOrder.length === 0) {
        await patchBackendState({ config });
        applyBackendState({ ...state, config });
        const newTaskId = uuidv4();
        await putBackendTask(newTaskId, {
          version: TASK_STATE_VERSION,
          prompt: '',
          concurrency: 2,
          enableSound: true,
          results: [],
          uploads: [],
          stats: DEFAULT_TASK_STATS,
        });
        await patchBackendState({ tasksOrder: [newTaskId] });
        if (backendModeRef.current) {
          setTasks([{ id: newTaskId, prompt: '' }]);
        }
        return;
      }
      applyBackendState(state);
    } catch (err: any) {
      console.error(err);
      message.error('后端模式初始化失败，请检查密码或服务状态');
      clearBackendToken();
      persistBackendMode(false);
      localHydratingRef.current = true;
      backendModeRef.current = false;
      setBackendModeState(false);
      const localConfig = loadConfig();
      setConfig(localConfig);
      setTasks(loadTasks());
      setGlobalStats(loadGlobalStats());
    } finally {
      setBackendSyncing(false);
    }
  }, [applyBackendState, config]);

  const handleBackendEnable = () => {
    setBackendPassword('');
    setBackendAuthPending(true);
  };

  const handleBackendDisable = () => {
    setBackendAuthPending(false);
    setBackendPassword('');
    clearBackendToken();
    persistBackendMode(false);
    localHydratingRef.current = true;
    backendModeRef.current = false;
    setBackendModeState(false);
    const localConfig = loadConfig();
    setConfig(localConfig);
    setTasks(loadTasks());
    setGlobalStats(loadGlobalStats());
  };

  const handleBackendAuthConfirm = async () => {
    if (!backendPassword) {
      message.warning('请输入后端密码');
      return;
    }
    setBackendAuthLoading(true);
    try {
      const token = await authBackend(backendPassword);
      setBackendToken(token);
      persistBackendMode(true);
      setBackendModeState(true);
      backendModeRef.current = true;
      setBackendAuthPending(false);
      setBackendPassword('');
    } catch (err: any) {
      console.error(err);
      message.error('后端密码错误或服务器不可用');
    } finally {
      setBackendAuthLoading(false);
    }
  };

  const handleBackendAuthCancel = () => {
    setBackendAuthPending(false);
    setBackendPassword('');
  };

  React.useEffect(() => {
    backendModeRef.current = backendMode;
  }, [backendMode]);

  React.useEffect(() => {
    if (!configVisible) return;
    form.setFieldsValue(config);
  }, [configVisible, config, form]);

  React.useEffect(() => {
    let isActive = true;
    if (backendMode) {
      backendCollectionHydratingRef.current = true;
      backendCollectionLastPayloadRef.current = JSON.stringify(collectedItemsRef.current);
      void (async () => {
        try {
          const items = await fetchBackendCollection();
          if (!isActive) return;
          const payload = JSON.stringify(items);
          backendCollectionLastPayloadRef.current = payload;
          setCollectedItems(items);
        } catch (err) {
          console.warn('后端收藏读取失败:', err);
        } finally {
          if (isActive) {
            backendCollectionHydratingRef.current = false;
          }
        }
      })();
      return () => {
        isActive = false;
      };
    }

    backendCollectionHydratingRef.current = false;
    backendCollectionLastPayloadRef.current = '';
    if (backendCollectionSyncTimerRef.current) {
      clearTimeout(backendCollectionSyncTimerRef.current);
      backendCollectionSyncTimerRef.current = null;
    }
    const localItems = loadCollectionItems();
    const filteredItems = localItems.filter((item) => {
      const localKey = item.localKey || '';
      if (localKey && isBackendImageKey(localKey)) return false;
      if (typeof item.image === 'string' && item.image.includes('/api/backend/image/')) {
        return false;
      }
      return true;
    });
    setCollectedItems(filteredItems);
    return () => {
      isActive = false;
    };
  }, [backendMode]);

  React.useEffect(() => {
    if (backendMode) return;
    if (localHydratingRef.current) return;
    saveCollectionItems(collectedItems);
  }, [collectedItems, backendMode]);

  React.useEffect(() => {
    collectedItemsRef.current = collectedItems;
  }, [collectedItems]);

  React.useEffect(() => {
    if (!backendMode) return;
    if (backendCollectionHydratingRef.current) return;
    const payload = JSON.stringify(collectedItems);
    if (payload === backendCollectionLastPayloadRef.current) return;
    backendCollectionLastPayloadRef.current = payload;
    if (backendCollectionSyncTimerRef.current) {
      clearTimeout(backendCollectionSyncTimerRef.current);
    }
    backendCollectionSyncTimerRef.current = window.setTimeout(() => {
      void putBackendCollection(collectedItems).catch((err) => {
        console.warn('后端收藏保存失败:', err);
      });
    }, 300);
    return () => {
      if (backendCollectionSyncTimerRef.current) {
        clearTimeout(backendCollectionSyncTimerRef.current);
        backendCollectionSyncTimerRef.current = null;
      }
    };
  }, [collectedItems, backendMode]);

  React.useEffect(() => {
    if (collectionCountRef.current > 0 && collectedItems.length === 0) {
      setCollectionRevision((prev) => prev + 1);
    }
    collectionCountRef.current = collectedItems.length;
  }, [collectedItems.length]);

  React.useEffect(() => {
    if (config.enableCollection) return;
    if (backendMode) return;
    if (localHydratingRef.current) return;
    const keepKeys = collectTaskImageKeys(tasks.map((task) => task.id));
    void cleanupUnusedImageCache(keepKeys);
  }, [config.enableCollection, tasks, backendMode]);

  React.useEffect(() => {
    if (!backendMode) {
      backendBootstrappedRef.current = false;
      backendReadyRef.current = false;
      return;
    }
    if (backendBootstrappedRef.current) return;
    backendBootstrappedRef.current = true;
    void bootstrapBackendState();
  }, [backendMode, bootstrapBackendState]);

  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    navigator.storage.persist().catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ config }).catch((err) => {
        console.warn('后端配置同步失败:', err);
      });
      return;
    }
    if (localHydratingRef.current) return;
    saveConfig(config);
  }, [config, backendMode]);

  React.useEffect(() => {
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ tasksOrder: tasks.map((task: TaskConfig) => task.id) }).catch((err) => {
        console.warn('后端任务列表同步失败:', err);
      });
      return;
    }
    if (localHydratingRef.current) return;
    safeStorageSet(
      STORAGE_KEYS.tasks,
      JSON.stringify(tasks.map((task: TaskConfig) => task.id)),
      'app cache',
    );
  }, [tasks, backendMode]);

  React.useEffect(() => {
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ globalStats }).catch((err) => {
        console.warn('后端统计同步失败:', err);
      });
      return;
    }
    if (localHydratingRef.current) return;
    safeStorageSet(
      STORAGE_KEYS.globalStats,
      JSON.stringify(globalStats),
      'app cache',
    );
  }, [globalStats, backendMode]);

  React.useEffect(() => {
    if (backendMode) return;
    if (!localHydratingRef.current) return;
    localHydratingRef.current = false;
  }, [backendMode]);

  React.useEffect(() => {
    if (!backendMode) return;
    const streamUrl = buildBackendStreamUrl();
    const source = new EventSource(streamUrl);
    const handleState = (event: MessageEvent) => {
      if (!backendModeRef.current) return;
      try {
        const payload = JSON.parse(event.data || '{}');
        applyBackendState(payload);
      } catch (err) {
        console.warn('解析后端状态事件失败:', err);
      }
    };
    const handleTask = (event: MessageEvent) => {
      if (!backendModeRef.current) return;
      try {
        const payload = JSON.parse(event.data || '{}');
        window.dispatchEvent(new CustomEvent('backend-task-update', { detail: payload }));
      } catch (err) {
        console.warn('解析后端任务事件失败:', err);
      }
    };
    source.addEventListener('state', handleState as EventListener);
    source.addEventListener('task', handleTask as EventListener);
    source.onerror = () => {
      console.warn('后端事件流断开，等待自动重连');
    };
    return () => {
      source.removeEventListener('state', handleState as EventListener);
      source.removeEventListener('task', handleTask as EventListener);
      source.close();
    };
  }, [backendMode, applyBackendState]);

  const fetchModels = async () => {
    const currentConfig = form.getFieldsValue();
    if (!currentConfig.apiKey) {
      message.warning('请先填写 API 密钥');
      return;
    }

    setLoadingModels(true);
    try {
      const apiFormat = currentConfig.apiFormat || 'openai';
      const apiUrl = resolveApiUrl(currentConfig.apiUrl, apiFormat);
      const versionFallback =
        apiFormat === 'openai' ? 'v1' : apiFormat === 'vertex' ? 'v1beta1' : 'v1beta';
      const version = resolveApiVersion(
        apiUrl,
        currentConfig.apiVersion,
        versionFallback,
      );
      const baseInfo = normalizeApiBase(apiUrl);
      const basePath = baseInfo.origin
        ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
        : apiUrl.replace(/\/+$/, '');

      let url = '';
      const headers: Record<string, string> = {};

      if (apiFormat === 'openai') {
        const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
        const openAiBase = hasVersion ? basePath : `${basePath}/${version}`;
        url = openAiBase.endsWith('/models') ? openAiBase : `${openAiBase}/models`;
        headers.Authorization = `Bearer ${currentConfig.apiKey}`;
      } else if (apiFormat === 'gemini') {
        const segments = [...baseInfo.segments];
        if (!inferApiVersionFromUrl(apiUrl)) {
          const modelIndex = segments.indexOf('models');
          if (modelIndex >= 0) {
            segments.splice(modelIndex, 0, version);
          } else {
            segments.push(version);
          }
        }
        const modelIndex = segments.indexOf('models');
        if (modelIndex >= 0) {
          segments.splice(modelIndex + 1);
        } else {
          segments.push('models');
        }
        const geminiBase = baseInfo.origin
          ? `${baseInfo.origin}/${segments.join('/')}`
          : `${segments.join('/')}`;
        const isOfficial = baseInfo.host === 'generativelanguage.googleapis.com';
        if (isOfficial) {
          url = `${geminiBase}?key=${encodeURIComponent(currentConfig.apiKey)}`;
        } else {
          url = geminiBase;
          headers.Authorization = `Bearer ${currentConfig.apiKey}`;
        }
      } else {
        message.warning('Vertex 模型列表暂不支持自动获取');
        return;
      }

      const res = await fetch(url, { headers });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      if (apiFormat === 'openai') {
        const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
        if (list.length === 0) {
          throw new Error('返回数据格式不正确');
        }
        const modelOptions = list
          .map((m: any) => ({ label: m.id || m.name, value: m.id || m.name }))
          .filter((item: any) => typeof item.value === 'string')
          .sort((a: any, b: any) => a.value.localeCompare(b.value));
        setModels(modelOptions);
        message.success(`成功获取 ${modelOptions.length} 个模型`);
      } else {
        const list = Array.isArray(data.models)
          ? data.models
          : Array.isArray(data.data)
            ? data.data
            : [];
        if (list.length === 0) {
          throw new Error('返回数据格式不正确');
        }
        const modelOptions = list
          .map((m: any) => {
            const rawName =
              typeof m?.name === 'string' ? m.name : typeof m?.id === 'string' ? m.id : '';
            const name = rawName.replace(/^models\//, '');
            return name ? { label: name, value: name } : null;
          })
          .filter((item: any) => item && item.value)
          .sort((a: any, b: any) => a.value.localeCompare(b.value));
        setModels(modelOptions);
        message.success(`成功获取 ${modelOptions.length} 个模型`);
      }
    } catch (e) {
      console.error(e);
      message.error('获取模型列表失败，请检查配置');
    } finally {
      setLoadingModels(false);
    }
  };

  // 当配置抽屉打开且有 API Key 时，如果列表为空，自动获取一次
  React.useEffect(() => {
    if (configVisible && config.apiKey && models.length === 0) {
      fetchModels();
    }
  }, [configVisible]);

  const handleAddTask = () => {
    const newTaskId = uuidv4();
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: '',
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    }
    setTasks([...tasks, { id: newTaskId, prompt: '' }]);
  };

  const handleCreateTaskFromPrompt = (prompt: string) => {
    const newTaskId = uuidv4();
    
    // Pre-save task state with prompt
    const storageKey = getTaskStorageKey(newTaskId);
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    } else {
      saveTaskState(storageKey, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        // If we could handle image upload here we would, but for now just prompt
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      });
    }

    setTasks([...tasks, { id: newTaskId, prompt }]);
  };

  const handleCreateTaskFromCollection = (prompt: string, referenceImages: CollectionItem[]) => {
    const newTaskId = uuidv4();
    
    const uploads: PersistedUploadImage[] = referenceImages
      .filter((img) => img.localKey)
      .map((img) => {
        const uid = uuidv4();
        return {
          uid,
          name: `reference-${uid.slice(0, 8)}.png`,
          type: 'image/png',
          localKey: img.localKey as string,
          lastModified: Date.now(),
          fromCollection: true,
          sourceSignature: img.sourceSignature,
        };
      });

    const storageKey = getTaskStorageKey(newTaskId);
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: uploads,
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    } else {
      saveTaskState(storageKey, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: uploads,
        stats: DEFAULT_TASK_STATS,
      });
    }

    setTasks([...tasks, { id: newTaskId, prompt }]);
    setCollectionVisible(false);
    message.success('已创建新任务');
  };

  const isCollectionCacheKey = (key: string) => key.startsWith('collection:');
  const isBackendImageKey = (key: string) => /\.[a-z0-9]+$/i.test(key);

  const handleRemoveTask = (id: string) => {
    if (backendMode) {
      void deleteBackendTask(id).catch((err) => {
        console.error(err);
        message.error('删除后端任务失败');
      });
    } else {
      const storageKey = getTaskStorageKey(id);
      const preserveKeys = config.enableCollection
        ? collectedItems
            .filter(
              (item) =>
                item.taskId === id &&
                typeof item.localKey === 'string' &&
                !isCollectionCacheKey(item.localKey) &&
                !isBackendImageKey(item.localKey),
            )
            .map((item) => item.localKey as string)
        : [];
      if (preserveKeys.length > 0) {
        void cleanupTaskCache(storageKey, { preserveImageKeys: preserveKeys });
      } else {
        void cleanupTaskCache(storageKey);
      }
    }
    setTasks(tasks.filter((t: TaskConfig) => t.id !== id));
  };

  const handleConfigChange = (changedValues: any, allValues: AppConfig) => {
    const nextFormat = allValues.apiFormat || config.apiFormat;
    let nextConfig = { ...config, ...allValues, apiFormat: nextFormat };
    const formatChanged =
      typeof changedValues?.apiFormat === 'string' &&
      changedValues.apiFormat !== config.apiFormat;

    if (formatChanged) {
      const formatConfig = loadFormatConfig(nextFormat);
      nextConfig = { ...nextConfig, ...formatConfig, apiFormat: nextFormat };
      form.setFieldsValue({
        apiUrl: formatConfig.apiUrl,
        apiKey: formatConfig.apiKey,
        model: formatConfig.model,
        apiVersion: formatConfig.apiVersion,
        vertexProjectId: formatConfig.vertexProjectId,
        vertexLocation: formatConfig.vertexLocation,
        vertexPublisher: formatConfig.vertexPublisher,
        thinkingBudget: formatConfig.thinkingBudget,
        includeThoughts: formatConfig.includeThoughts,
        includeImageConfig: formatConfig.includeImageConfig,
        includeSafetySettings: formatConfig.includeSafetySettings,
        safety: formatConfig.safety,
        imageConfig: formatConfig.imageConfig,
        webpQuality: formatConfig.webpQuality,
        useResponseModalities: formatConfig.useResponseModalities,
        customJson: formatConfig.customJson,
      });
      setModels([]);
    }

    if (typeof nextConfig.apiUrl === 'string') {
      const inferredVersion = inferApiVersionFromUrl(nextConfig.apiUrl);
      if (inferredVersion && inferredVersion !== nextConfig.apiVersion) {
        nextConfig.apiVersion = inferredVersion;
        form.setFieldsValue({ apiVersion: inferredVersion });
      }
      if (nextFormat === 'vertex') {
        const inferredProjectId = extractVertexProjectId(nextConfig.apiUrl);
        if (inferredProjectId && inferredProjectId !== nextConfig.vertexProjectId) {
          nextConfig.vertexProjectId = inferredProjectId;
          form.setFieldsValue({ vertexProjectId: inferredProjectId });
        }
      }
    }

    setConfig(nextConfig);
  };

  const normalizePrompt = (prompt: string) =>
    prompt.trim().replace(/\s+/g, ' ');

  const buildPromptKey = (prompt: string) => {
    const normalized = normalizePrompt(prompt);
    return normalized ? normalized.toLowerCase() : '__empty__';
  };

  const isUploadCollectionKey = (key?: string) =>
    Boolean(key && key.startsWith('collection:upload:'));

  const isUploadCollectionItem = (item: CollectionItem) =>
    isUploadCollectionKey(item.id) || isUploadCollectionKey(item.localKey);

  const getCollectionGroupKey = (item: CollectionItem) =>
    buildPromptKey(typeof item.prompt === 'string' ? item.prompt : '');

  const getCollectionKey = (item: CollectionItem, useIdOnly = false) => {
    if (isUploadCollectionItem(item) && item.sourceSignature) {
      return `upload:${buildPromptKey(item.prompt)}:${item.sourceSignature}`;
    }
    return useIdOnly ? item.id : item.localKey || item.image || item.id;
  };


  const handleCollect = (item: CollectionItem) => {
    const normalized: CollectionItem = {
      ...item,
      id: item.id || item.localKey || uuidv4(),
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      taskId: typeof item.taskId === 'string' ? item.taskId : '',
    };
    const incomingKey = getCollectionKey(normalized, backendMode);
    setCollectedItems((prev) => {
      if (!incomingKey) return [normalized, ...prev];
      const existingIndex = prev.findIndex(
        (entry) => getCollectionKey(entry, backendMode) === incomingKey,
      );
      if (existingIndex === -1) {
        return [normalized, ...prev];
      }
      const existing = prev[existingIndex];
      const updated = { ...existing, ...normalized, id: existing.id || normalized.id };
      const next = prev.filter(
        (entry) => getCollectionKey(entry, backendMode) !== incomingKey,
      );
      return [updated, ...next];
    });
  };

  const getCollectionCacheKey = (item: CollectionItem) => {
    if (item.localKey) return item.localKey;
    if (item.id && isCollectionCacheKey(item.id)) return item.id;
    return undefined;
  };

  const handleRemoveCollectedItem = (id: string) => {
    setCollectedItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (!backendMode) {
        const cacheKey = target ? getCollectionCacheKey(target) : undefined;
        if (cacheKey) {
          void deleteImageCache(cacheKey);
        }
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleRemoveCollectedGroup = (groupKey: string) => {
    setCollectedItems((prev) => {
      const toRemove = prev.filter(
        (item) => getCollectionGroupKey(item) === groupKey,
      );
      if (!backendMode) {
        const keys = Array.from(
          new Set(
            toRemove
              .map((item) => getCollectionCacheKey(item))
              .filter((key): key is string => typeof key === 'string'),
          ),
        );
        keys.forEach((key) => {
          void deleteImageCache(key);
        });
      }
      return prev.filter((item) => getCollectionGroupKey(item) !== groupKey);
    });
  };

  const handleClearCollection = () => {
    if (!backendMode) {
      const keys = Array.from(
        new Set(
          collectedItems
            .map((item) =>
              getCollectionCacheKey(item),
            )
            .filter((key): key is string => typeof key === 'string'),
        ),
      );
      keys.forEach((key) => {
        void deleteImageCache(key);
      });
    }
    setCollectedItems([]);
  };

  const updateGlobalStats = useCallback((type: 'request' | 'success' | 'fail', duration?: number) => {
    setGlobalStats((prev: GlobalStats) => {
      const newState = {
        ...prev,
        totalRequests: type === 'request' ? prev.totalRequests + 1 : prev.totalRequests,
        successCount: type === 'success' ? prev.successCount + 1 : prev.successCount,
      };

      if (type === 'success' && duration) {
        newState.totalTime = prev.totalTime + duration;
        newState.fastestTime = prev.fastestTime === 0 ? duration : Math.min(prev.fastestTime, duration);
        newState.slowestTime = Math.max(prev.slowestTime, duration);
      }

      return newState;
    });
  }, []);

  const handleClearGlobalStats = () => {
    setGlobalStats({ ...EMPTY_GLOBAL_STATS });
    message.success('数据总览统计已清空');
  };

  const successRate = calculateSuccessRate(
    globalStats.totalRequests,
    globalStats.successCount,
  );
  
  const averageTime = globalStats.successCount > 0 
    ? formatDuration(globalStats.totalTime / globalStats.successCount)
    : '0.0s';
  
  const fastestTimeStr = formatDuration(globalStats.fastestTime);

  const slowestTimeStr = formatDuration(globalStats.slowestTime);
  const backendSwitchChecked = backendMode || backendAuthPending;

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#FF9EB5',
          colorTextBase: '#665555',
          colorBgBase: '#FFF9FA',
          borderRadius: 20,
          fontFamily: "'Nunito', 'Quicksand', sans-serif",
        },
        components: {
          Button: {
            colorPrimary: '#FF9EB5',
            algorithm: true,
            fontWeight: 700,
          },
          Input: {
            colorBgContainer: '#FFF0F3',
            activeBorderColor: '#FF9EB5',
            hoverBorderColor: '#FFB7C5',
          },
          Drawer: {
            colorBgElevated: '#FFFFFF',
          }
        }
      }}
    >
      <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
        {/* 顶部导航栏 */}
        <Header className="app-header" style={{ 
          height: 72, 
          // padding handled in css
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.5)',
          boxShadow: '0 4px 20px rgba(255, 158, 181, 0.05)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <div className="hover-scale" style={{ 
              width: 40, 
              height: 40, 
              background: 'linear-gradient(135deg, #FF9EB5 0%, #FF7090 100%)', 
              borderRadius: 14, 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(255, 158, 181, 0.4)',
              transform: 'rotate(-6deg)',
            }}>
              <HeartFilled style={{ fontSize: 20, color: '#fff' }} />
            </div>
            <div>
              <Title level={4} style={{ margin: 0, color: '#665555', fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1, whiteSpace: 'nowrap' }}>
                萌图 <span style={{ color: '#FF9EB5' }}>工坊</span>
              </Title>
            </div>
          </div>

          <Space size={8} className="header-actions">
            <Tooltip title="提示词广场">
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                className="mobile-hidden"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                广场
              </Button>
            </Tooltip>
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                shape="circle"
                className="desktop-hidden circle-icon-btn"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
            />
            
            <Button 
              icon={<SettingFilled />} 
              onClick={() => setConfigVisible(true)}
              size="large"
              className="mobile-hidden"
            >
              系统配置
            </Button>
            <Button 
              icon={<SettingFilled />} 
              onClick={() => setConfigVisible(true)}
              size="large"
              shape="circle"
              className="desktop-hidden circle-icon-btn"
            />
            <Button 
              type="primary" 
              icon={<PlusOutlined />} 
              onClick={handleAddTask}
              size="large"
            >
              新建任务
            </Button>
          </Space>
        </Header>
        
        <Content style={{ padding: '24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
          
          {/* 数据仪表盘 - 重新设计 */}
          <div className="fade-in-up" style={{ marginBottom: 32 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 16,
                paddingLeft: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AppstoreFilled style={{ fontSize: 18, color: '#FF9EB5' }} />
                <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
                  数据总览
                </Text>
              </div>
              <Button
                size="small"
                icon={<DeleteFilled />}
                onClick={handleClearGlobalStats}
                disabled={backendSyncing}
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                清空统计
              </Button>
            </div>
            
            <div className="stat-panel">
              <Row gutter={[16, 16]}>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#E0F7FA', color: '#00BCD4',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value">{globalStats.totalRequests}</div>
                    <div className="stat-label">总请求数</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#E8F5E9', color: '#4CAF50',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <CheckCircleFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#4CAF50' }}>{globalStats.successCount}</div>
                    <div className="stat-label">成功生成</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#FFF8E1', color: '#FFC107',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ExperimentFilled />
                    </div>
                    <div className="stat-value" style={{ color: successRate > 80 ? '#4CAF50' : '#FFC107' }}>
                      {successRate}%
                    </div>
                    <div className="stat-label">成功率</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#E3F2FD', color: '#2196F3',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#2196F3' }}>{fastestTimeStr}</div>
                    <div className="stat-label">最快用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#FFEBEE', color: '#FF5252',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#FF5252' }}>{slowestTimeStr}</div>
                    <div className="stat-label">最慢用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#F3E5F5', color: '#9C27B0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ReloadOutlined />
                    </div>
                    <div className="stat-value" style={{ color: '#9C27B0' }}>{averageTime}</div>
                    <div className="stat-label">平均用时</div>
                  </div>
                </Col>
              </Row>
            </div>
          </div>

          {/* 任务列表 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, paddingLeft: 4 }}>
            <div style={{ 
              width: 24, height: 24, borderRadius: '50%', background: '#FF9EB5', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
              fontSize: 12, fontWeight: 700
            }}>
              {tasks.length}
            </div>
            <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
              进行中的任务
            </Text>
          </div>

          <DndContext 
            sensors={sensors} 
            collisionDetection={closestCenter} 
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext 
              items={tasks.map(t => t.id)}
              strategy={rectSortingStrategy}
            >
              <Row gutter={[24, 24]}>
                {tasks.map((task: TaskConfig) => (
                  <SortableTaskItem 
                    key={task.id} 
                    task={task} 
                    config={config}
                    backendMode={backendMode}
                    onRemove={handleRemoveTask}
                    onStatsUpdate={updateGlobalStats}
                    onCollect={handleCollect}
                    collectionRevision={collectionRevision}
                  />
                ))}
              </Row>
            </SortableContext>
            <DragOverlay dropAnimation={dropAnimation}>
              {activeId ? (
                <div 
                  className="drag-overlay-item" 
                  style={{ 
                    cursor: 'grabbing',
                    width: activeItemWidth 
                  }}
                >
                   <ImageTask
                      id={activeId}
                      storageKey={getTaskStorageKey(activeId)}
                      config={config}
                      backendMode={backendMode}
                      onRemove={() => handleRemoveTask(activeId)}
                      onStatsUpdate={updateGlobalStats}
                      collectionRevision={collectionRevision}
                      dragAttributes={{}}
                      dragListeners={{}}
                    />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </Content>

        <PromptDrawer 
          visible={promptDrawerVisible}
          onClose={() => setPromptDrawerVisible(false)}
          onCreateTask={handleCreateTaskFromPrompt}
        />
        
        {config.enableCollection && (
          <CollectionBox
            visible={collectionVisible}
            backendMode={backendMode}
            onClose={() => setCollectionVisible(!collectionVisible)}
            collectedItems={collectedItems}
            onRemoveItem={handleRemoveCollectedItem}
            onRemoveGroup={handleRemoveCollectedGroup}
            onClear={handleClearCollection}
            onCreateTask={handleCreateTaskFromCollection}
          />
        )}

        {/* 配置抽屉 */}
        <Drawer
          title={
            <Space>
              <div style={{ 
                width: 32, height: 32, borderRadius: 10, background: '#FFF0F3', 
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FF9EB5' 
              }}>
                <SettingFilled />
              </div>
              <span style={{ fontWeight: 800, fontSize: 18, color: '#665555' }}>系统配置</span>
            </Space>
          }
          placement="right"
          onClose={() => {
            setConfigVisible(false);
            if (backendAuthPending) {
              handleBackendAuthCancel();
            }
          }}
          open={configVisible}
          width={400}
          styles={{ body: { padding: 24 } }}
        >
          <Form
            layout="vertical"
            initialValues={config}
            onValuesChange={handleConfigChange}
            form={form}
          >
            <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>API 格式</span>}>
              <Form.Item name="apiFormat" noStyle>
                <Radio.Group optionType="button" buttonStyle="solid">
                  <Radio.Button value="openai">OpenAI</Radio.Button>
                  <Radio.Button value="gemini">Gemini</Radio.Button>
                  <Radio.Button value="vertex">Vertex</Radio.Button>
                </Radio.Group>
              </Form.Item>
            </Form.Item>

            <Form.Item
              noStyle
              shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}
            >
              {({ getFieldValue }) => {
                const apiFormat = getFieldValue('apiFormat') || 'openai';
                if (apiFormat === 'openai') {
                  return null;
                }
                return (
                  <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>API 版本</span>}>
                    <Form.Item name="apiVersion" noStyle>
                      <AutoComplete
                        options={API_VERSION_OPTIONS.map((version) => ({ value: version }))}
                        filterOption={(inputValue, option) =>
                          option!.value.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1
                        }
                      >
                        <Input
                          size="large"
                          placeholder="v1beta"
                          prefix={<ApiFilled style={{ color: '#FF9EB5' }} />}
                        />
                      </AutoComplete>
                    </Form.Item>
                  </Form.Item>
                );
              }}
            </Form.Item>

            <Form.Item
              label={<span style={{ fontWeight: 700, color: '#665555' }}>API 接口地址</span>}
              shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}
            >
              {({ getFieldValue }) => {
                const format = (getFieldValue('apiFormat') || 'openai') as ApiFormat;
                const placeholder =
                  DEFAULT_API_BASES[format] || DEFAULT_API_BASES.openai;
                return (
                  <Form.Item name="apiUrl" noStyle>
                    <Input
                      size="large"
                      placeholder={placeholder}
                      prefix={<ApiFilled style={{ color: '#FF9EB5' }} />}
                    />
                  </Form.Item>
                );
              }}
            </Form.Item>

            <Form.Item name="apiKey" label={<span style={{ fontWeight: 700, color: '#665555' }}>API 密钥</span>}>
              <Input.Password size="large" placeholder="sk-..." prefix={<SafetyCertificateFilled style={{ color: '#FF9EB5' }} />} />
            </Form.Item>
            
            <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>模型名称</span>} style={{ marginBottom: 48 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <Form.Item name="model" noStyle>
                    <AutoComplete
                      className="model-autocomplete"
                      options={models}
                      filterOption={(inputValue, option) =>
                        option!.value.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1
                      }
                      dropdownMatchSelectWidth={false}
                      dropdownStyle={{ minWidth: 300 }}
                    >
                      <Input 
                        size="large" 
                        placeholder="请输入模型名称"
                        prefix={<ExperimentFilled style={{ color: '#FF9EB5' }} />} 
                      />
                    </AutoComplete>
                  </Form.Item>
                </div>
                <Tooltip title="获取模型列表">
                  <Button 
                    className="model-refresh-btn"
                    icon={<ReloadOutlined spin={loadingModels} />} 
                    onClick={fetchModels}
                    size="large"
                    shape="circle"
                  />
                </Tooltip>
              </div>
            </Form.Item>
            
            <div style={{ background: '#F8F9FA', padding: '16px', borderRadius: 16, marginBottom: 24, border: '1px solid #eee' }}>
              <Form.Item
                label={<span style={{ fontWeight: 700, color: '#665555' }}>流式传输</span>}
                style={{ marginBottom: 12 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>启用实时生成进度更新</Text>
                  <Form.Item name="stream" valuePropName="checked" noStyle>
                    <Switch />
                  </Form.Item>
                </div>
              </Form.Item>

              <Form.Item
                label={<span style={{ fontWeight: 700, color: '#665555' }}>图片收纳</span>}
                style={{ marginBottom: 0 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>自动收纳生成的图片和提示词</Text>
                  <Form.Item name="enableCollection" valuePropName="checked" noStyle>
                    <Switch />
                  </Form.Item>
                </div>
              </Form.Item>
            </div>

            <Form.Item
              noStyle
              shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}
            >
              {({ getFieldValue }) => {
                const apiFormat = getFieldValue('apiFormat') || 'openai';
                if (apiFormat === 'openai') {
                  return null;
                }
                return (
                  <Collapse
                    ghost
                    items={[{
                      key: '1',
                      label: <span style={{ fontWeight: 700, color: '#8B5E34' }}>高级设置（Gemini / Vertex）</span>,
                      style: { background: '#FFF7E6', borderRadius: 16, border: '1px dashed #FFD591', marginBottom: 24 },
                      children: (
                        <div>
                            <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>思考配置</Text>
                            <Form.Item
                              name="includeThoughts"
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>启用思考</span>}
                              valuePropName="checked"
                              style={{ marginBottom: 8 }}
                            >
                              <Switch />
                            </Form.Item>
                            <Form.Item
                              name="thinkingBudget"
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>思考预算 (Tokens)</span>}
                              style={{ marginBottom: 0 }}
                            >
                              <LazySliderInput min={0} max={8192} step={128} />
                            </Form.Item>

                            <Divider style={{ margin: '12px 0' }} />

                            <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>图像参数</Text>
                            <Form.Item
                              name="includeImageConfig"
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>启用图像配置</span>}
                              valuePropName="checked"
                              style={{ marginBottom: 8 }}
                            >
                              <Switch />
                            </Form.Item>
                            <Form.Item
                              name={['imageConfig', 'imageSize']}
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>分辨率</span>}
                              style={{ marginBottom: 8 }}
                            >
                              <Radio.Group optionType="button" buttonStyle="solid">
                                {IMAGE_SIZE_OPTIONS.map((size) => (
                                  <Radio.Button key={size} value={size}>
                                    {size}
                                  </Radio.Button>
                                ))}
                              </Radio.Group>
                            </Form.Item>
                            <Form.Item
                              name={['imageConfig', 'aspectRatio']}
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>比例</span>}
                              style={{ marginBottom: 8 }}
                            >
                              <Select
                                options={ASPECT_RATIO_OPTIONS.map((value) => ({ value, label: value }))}
                              />
                            </Form.Item>

                            <Form.Item
                              name="webpQuality"
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>WebP 质量</span>}
                              style={{ marginBottom: 8 }}
                            >
                              <LazySliderInput min={50} max={100} step={1} />
                            </Form.Item>

                            <Form.Item
                              name="useResponseModalities"
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>响应模态</span>}
                              valuePropName="checked"
                              extra="TEXT + IMAGE（官方端点可用）"
                              style={{ marginBottom: 0 }}
                            >
                              <Switch />
                            </Form.Item>

                            <Divider style={{ margin: '12px 0' }} />

                            <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>安全设置</Text>
                            <Form.Item
                              name="includeSafetySettings"
                              label={<span style={{ fontWeight: 600, color: '#665555' }}>启用安全设置</span>}
                              valuePropName="checked"
                              style={{ marginBottom: 8 }}
                            >
                              <Switch />
                            </Form.Item>
                            <Row gutter={12}>
                              <Col span={12}>
                                <Form.Item
                                  name={['safety', 'HARM_CATEGORY_HARASSMENT']}
                                  label={<span style={{ fontWeight: 600, color: '#665555' }}>骚扰内容</span>}
                                  style={{ marginBottom: 8 }}
                                >
                                  <Select options={SAFETY_OPTIONS} />
                                </Form.Item>
                              </Col>
                              <Col span={12}>
                                <Form.Item
                                  name={['safety', 'HARM_CATEGORY_HATE_SPEECH']}
                                  label={<span style={{ fontWeight: 600, color: '#665555' }}>仇恨言论</span>}
                                  style={{ marginBottom: 8 }}
                                >
                                  <Select options={SAFETY_OPTIONS} />
                                </Form.Item>
                              </Col>
                              <Col span={12}>
                                <Form.Item
                                  name={['safety', 'HARM_CATEGORY_SEXUALLY_EXPLICIT']}
                                  label={<span style={{ fontWeight: 600, color: '#665555' }}>色情内容</span>}
                                  style={{ marginBottom: 8 }}
                                >
                                  <Select options={SAFETY_OPTIONS} />
                                </Form.Item>
                              </Col>
                              <Col span={12}>
                                <Form.Item
                                  name={['safety', 'HARM_CATEGORY_DANGEROUS_CONTENT']}
                                  label={<span style={{ fontWeight: 600, color: '#665555' }}>危险内容</span>}
                                  style={{ marginBottom: 8 }}
                                >
                                  <Select options={SAFETY_OPTIONS} />
                                </Form.Item>
                              </Col>
                              <Col span={12}>
                                <Form.Item
                                  name={['safety', 'HARM_CATEGORY_CIVIC_INTEGRITY']}
                                  label={<span style={{ fontWeight: 600, color: '#665555' }}>公民诚信</span>}
                                  style={{ marginBottom: 0 }}
                                >
                                  <Select options={SAFETY_OPTIONS} />
                                </Form.Item>
                              </Col>
                            </Row>

                            <Divider style={{ margin: '12px 0' }} />

                            <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>自定义 JSON</Text>
                            <Form.Item
                              name="customJson"
                              extra="将合并到请求体中（仅 Gemini / Vertex）"
                              style={{ marginBottom: 0 }}
                            >
                              <Input.TextArea
                                rows={4}
                                placeholder='{"generationConfig": {"topK": 40}}'
                              />
                            </Form.Item>
                        </div>
                      )
                    }]}
                  />
                );
              }}
            </Form.Item>

            <div style={{ background: '#F1F7FF', padding: '16px', borderRadius: 16, marginBottom: 24, border: '1px dashed #91C1FF' }}>
              <Form.Item 
                label={<span style={{ fontWeight: 700, color: '#665555' }}>后端模式</span>}
                style={{ marginBottom: 8 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                  <Text type="secondary" style={{ fontSize: 13, flex: 1 }}>
                    开启后将配置与任务缓存到服务器，支持多端同步
                  </Text>
                  <Switch
                    checked={backendSwitchChecked}
                    loading={backendSyncing}
                    disabled={backendAuthLoading}
                    onChange={(checked) => {
                      if (checked) {
                        if (!backendMode) {
                          handleBackendEnable();
                        }
                      } else {
                        if (backendMode) {
                          handleBackendDisable();
                        } else {
                          handleBackendAuthCancel();
                        }
                      }
                    }}
                  />
                </div>
              </Form.Item>
              <div style={{ marginTop: 16 }}>
                <Text type="secondary" style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5, display: 'block' }}>
                  需要在服务端 .env 中设置 BACKEND_PASSWORD。开启后生图请求将由服务器执行并自动缓存。
                </Text>
              </div>
              <div className={`password-collapse-container ${backendAuthPending && !backendMode ? 'open' : ''}`}>
                <div className="password-content-wrapper">
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Text type="secondary" style={{ fontSize: 12, color: '#6B7280' }}>
                      请输入 .env 中配置的 BACKEND_PASSWORD。
                    </Text>
                    <Input.Password
                      size="large"
                      value={backendPassword}
                      placeholder="后端密码"
                      prefix={<KeyOutlined style={{ color: '#FF9EB5', fontSize: 18 }} />}
                      onChange={(e) => setBackendPassword(e.target.value)}
                      onPressEnter={() => void handleBackendAuthConfirm()}
                    />
                    <Space size={8}>
                      <Button
                        size="small"
                        onClick={() => void handleBackendAuthConfirm()}
                        loading={backendAuthLoading}
                        type="primary"
                      >
                        验证
                      </Button>
                      <Button size="small" type="text" onClick={handleBackendAuthCancel}>
                        取消
                      </Button>
                    </Space>
                  </Space>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 24, padding: 16, background: '#FFF8E1', borderRadius: 16, border: '1px dashed #FFC107' }}>
              <Space align="start">
                <ThunderboltFilled style={{ color: '#FFC107', marginTop: 4, fontSize: 16 }} />
                <Text type="secondary" style={{ fontSize: 13, color: '#8D6E63', lineHeight: 1.5 }}>
                  设置将自动应用于所有活动任务窗口。请确保您的 API 密钥有足够的配额。
                </Text>
              </Space>
            </div>
          </Form>
        </Drawer>

      </Layout>
    </ConfigProvider>
  );
}

export default App;
