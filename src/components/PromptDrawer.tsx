import React, { useState, useEffect, useMemo } from 'react';
import { 
  Drawer, Input, Button, Tag, 
  Typography, Space, Empty, Spin, 
  Modal, message, Tabs, Badge, Grid, 
  Tooltip, Avatar, Select, Image
} from 'antd';
import { 
  ReloadOutlined, StarFilled, StarOutlined, 
  PlusCircleFilled, AppstoreFilled,
  FilterFilled, UserOutlined, FileTextOutlined,
  FireFilled, LeftOutlined, RightOutlined,
  CopyOutlined, CompassFilled
} from '@ant-design/icons';
import type { PromptData, PromptItem } from '../types/prompt';
import { safeStorageGet, safeStorageSet } from '../utils/storage';

const { Title, Text } = Typography;
const { useBreakpoint } = Grid;

interface PromptDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCreateTask: (prompt: string) => void;
}

type ExtendedPromptItem = PromptItem & { sectionId: string; sectionTitle: string };

const DEFAULT_DATA_SOURCE = 'https://raw.githubusercontent.com/unknowlei/nanobanana-website/refs/heads/main/public/data.json';
const STORAGE_KEY_FAVORITES = 'moe-atelier:favorites';
const STORAGE_KEY_SOURCE = 'moe-atelier:prompt-source';
const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

// 样式常量
const COLORS = {
  primary: '#FF9EB5', // 柔和粉
  secondary: '#FFC2D1', // 浅粉
  accent: '#FFE5EC', // 极浅粉
  text: '#5D4037', // 咖啡色
  textLight: '#8D6E63', // 浅咖啡
  bg: '#FFF9FA', // 背景白偏粉
  white: '#FFFFFF',
  gold: '#FFC107',
  new: '#FF5252'
};

const SearchIcon: React.FC<{ color: string; size?: number }> = ({ color, size = 20 }) => (
  <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width={size} height={size}>
    <path d="M750.08 192.512c-154.112-154.112-403.456-154.112-557.568 0s-154.112 403.456 0 557.568c138.24 138.24 352.768 152.064 506.88 42.496l135.68 135.68c25.6 25.6 67.584 25.6 93.184 0s25.6-67.584 0-93.184l-135.68-135.68c109.056-154.112 95.744-368.64-42.496-506.88z m-93.184 464.384c-102.4 102.4-269.312 102.4-371.712 0s-102.4-269.312 0-371.712 269.312-102.4 371.712 0 102.912 269.312 0 371.712z" fill={color}></path>
  </svg>
);

const PromptDrawer: React.FC<PromptDrawerProps> = ({ visible, onClose, onCreateTask }) => {
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const [sourceUrl, setSourceUrl] = useState<string>(() => safeStorageGet(STORAGE_KEY_SOURCE) || DEFAULT_DATA_SOURCE);
  const [data, setData] = useState<PromptData | null>(null);
  const [loading, setLoading] = useState(false);
  
  // Tabs: 'all', 'new', 'favorites', or sectionId
  const [activeTab, setActiveTab] = useState<string>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  
  // 移动端筛选抽屉
  const [mobileFilterVisible, setMobileFilterVisible] = useState(false);
  const [mobileSearchVisible, setMobileSearchVisible] = useState(false);

  const mobileInactiveIconColor = COLORS.text;

  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const stored = safeStorageGet(STORAGE_KEY_FAVORITES);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Preview Modal State
  const [previewPrompt, setPreviewPrompt] = useState<ExtendedPromptItem | null>(null);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);
  const [activeVariantIndex, setActiveVariantIndex] = useState(0); // 0: Main, 1+: Variants
  const [imageAspectRatio, setImageAspectRatio] = useState<'landscape' | 'portrait' | null>(null);

  useEffect(() => {
    if (visible && !data) {
      fetchData();
    }
  }, [visible]);

  useEffect(() => {
    safeStorageSet(STORAGE_KEY_FAVORITES, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    safeStorageSet(STORAGE_KEY_SOURCE, sourceUrl);
  }, [sourceUrl]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('Network response was not ok');
      const jsonData = await response.json();
      setData(jsonData);
    } catch (error) {
      message.error('获取数据失败，请检查链接是否正确');
      console.error('Fetch error:', error);
    } finally {
      setLoading(false);
    }
  };

  const isNewItem = (id: string) => {
    if (!id) return false;
    let timestamp: number | null = null;
    
    if (/^\d{13}$/.test(id)) {
      timestamp = parseInt(id, 10);
    } else if (id.startsWith('imported-') || id.startsWith('u-')) {
      const part = id.split('-')[1];
      if (/^\d{13}$/.test(part)) timestamp = parseInt(part, 10);
    }
    
    return timestamp ? Date.now() - timestamp <= NEW_WINDOW_MS : false;
  };

  const toggleFavorite = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setFavorites(prev => 
      prev.includes(id) ? prev.filter(fid => fid !== id) : [...prev, id]
    );
  };

  const handleUsePrompt = (content: string) => {
    onCreateTask(content);
    setPreviewPrompt(null);
    onClose();
    message.success('已应用提示词 ✨');
  };

  // 数据处理
  const allPrompts = useMemo(() => {
    if (!data) return [];
    return data.sections.flatMap(section => 
      section.prompts.map(p => ({ ...p, sectionId: section.id, sectionTitle: section.title }))
    );
  }, [data]);

  const newPrompts = useMemo(() => {
    return allPrompts.filter(p => isNewItem(p.id));
  }, [allPrompts]);

  const filteredPrompts = useMemo(() => {
    let result = allPrompts;

    // Filter by Tab
    if (activeTab === 'favorites') {
      result = result.filter(p => favorites.includes(p.id));
    } else if (activeTab === 'new') {
      result = result.filter(p => isNewItem(p.id));
    } else if (activeTab !== 'all') {
      result = result.filter(p => p.sectionId === activeTab);
    }

    // Filter by Search
    if (searchText) {
      const lowerSearch = searchText.toLowerCase();
      result = result.filter(p => 
        p.title.toLowerCase().includes(lowerSearch) || 
        p.content.toLowerCase().includes(lowerSearch) ||
        p.tags?.some(t => t.toLowerCase().includes(lowerSearch))
      );
    }

    // Filter by Tags
    if (selectedTags.length > 0) {
      result = result.filter(p => 
        selectedTags.every(tag => p.tags?.includes(tag))
      );
    }

    return result
      .map((prompt, index) => ({ prompt, index }))
      .sort((a, b) => {
        const aNew = isNewItem(a.prompt.id);
        const bNew = isNewItem(b.prompt.id);
        if (aNew !== bNew) return aNew ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ prompt }) => prompt);
  }, [allPrompts, activeTab, searchText, selectedTags, favorites]);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    // 从当前 Tab 上下文收集标签
    let contextPrompts = allPrompts;
    if (activeTab === 'favorites') {
      contextPrompts = contextPrompts.filter(p => favorites.includes(p.id));
    } else if (activeTab === 'new') {
      contextPrompts = contextPrompts.filter(p => isNewItem(p.id));
    } else if (activeTab !== 'all') {
      contextPrompts = contextPrompts.filter(p => p.sectionId === activeTab);
    }

    contextPrompts.forEach(p => {
      p.tags?.forEach(t => tags.add(t));
    });
    return Array.from(tags).sort();
  }, [allPrompts, activeTab, favorites]);

  // Preview Modal Logic
  const openPreview = (prompt: ExtendedPromptItem) => {
    setPreviewPrompt(prompt);
    setPreviewImageIndex(0);
    setActiveVariantIndex(0);
    setImageAspectRatio(null); // Reset layout detection
  };

  const currentPreviewData = useMemo(() => {
    if (!previewPrompt) return null;
    if (activeVariantIndex === 0) {
      return {
        content: previewPrompt.content,
        contributor: previewPrompt.contributor,
        images: previewPrompt.images || []
      };
    } else {
      const variant = previewPrompt.similar?.[activeVariantIndex - 1];
      return {
        content: variant?.content || '',
        contributor: variant?.contributor,
        // 变体目前没有独立图片数组，通常复用主图片或追加在主图片数组中
        // 根据 nanobanana 逻辑，所有图片都在 prompt.images 中
        images: previewPrompt.images || [] 
      };
    }
  }, [previewPrompt, activeVariantIndex]);

  // Layout Detection
  useEffect(() => {
    if (!currentPreviewData || currentPreviewData.images.length === 0) return;
    
    const img = new window.Image();
    img.src = currentPreviewData.images[previewImageIndex];
    img.onload = () => {
      if (img.naturalWidth > img.naturalHeight) {
        setImageAspectRatio('landscape');
      } else {
        setImageAspectRatio('portrait');
      }
    };
  }, [currentPreviewData, previewImageIndex]);

  // Render Sidebar
  const renderSidebar = () => (
    <div style={{ 
      display: 'flex', flexDirection: 'column', gap: 24,
      height: '100%',
      overflowY: isMobile ? 'auto' : 'hidden',
      overflowX: 'hidden',
      padding: isMobile ? 20 : 24,
      background: isMobile ? 'transparent' : 'rgba(255, 255, 255, 0.6)',
      backdropFilter: isMobile ? 'none' : 'blur(10px)',
      borderRight: isMobile ? 'none' : `1px solid ${COLORS.accent}`
    }}>
      {!isMobile && (
        <Input 
          size="large"
          prefix={
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <SearchIcon color={COLORS.primary} />
            </span>
          }
          placeholder="搜索提示词..." 
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          className="custom-search-input"
        />
      )}

      {/* Categories */}
      <div>
        {!isMobile && <Title level={5} style={{ color: COLORS.text, marginBottom: 12, fontSize: 14, paddingLeft: 8 }}>
          <AppstoreFilled style={{ marginRight: 8 }} /> 分类
        </Title>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { id: 'all', label: '全部', color: '#FF9EB5', icon: CompassFilled },
            { id: 'new', label: '最新', color: COLORS.new, icon: FireFilled, badge: newPrompts.length },
            { id: 'favorites', label: '我的收藏', color: COLORS.gold, icon: StarFilled, badge: favorites.length }
          ].map(item => {
            const isActive = activeTab === item.id;
            const IconComponent = item.icon;
            return (
              <Button 
                key={item.id}
                type={isActive ? 'primary' : 'text'} 
                block 
                style={{ 
                  textAlign: 'left', 
                  justifyContent: 'space-between',
                  height: 40,
                  borderRadius: 12,
                  background: isActive ? COLORS.primary : 'transparent',
                  color: isActive ? '#fff' : COLORS.text,
                  fontWeight: isActive ? 700 : 400
                }}
                onClick={() => {
                  setActiveTab(item.id);
                  if (isMobile) setMobileFilterVisible(false);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <IconComponent style={{ color: isActive ? '#fff' : item.color }} />
                  <span style={{ marginLeft: 8 }}>{item.label}</span>
                </div>
                {item.badge ? <Badge count={item.badge} style={{ backgroundColor: item.id === 'new' ? COLORS.new : COLORS.gold }} /> : null}
              </Button>
            );
          })}
          
          <div style={{ height: 1, background: COLORS.secondary, margin: '8px 0', opacity: 0.5 }}></div>

          {data?.sections.map(section => (
            <Button 
              key={section.id}
              type={activeTab === section.id ? 'primary' : 'text'}
              block
              style={{ 
                textAlign: 'left', 
                justifyContent: 'flex-start',
                borderRadius: 12,
                background: activeTab === section.id ? COLORS.secondary : 'transparent',
                color: activeTab === section.id ? COLORS.text : COLORS.textLight,
                fontWeight: activeTab === section.id ? 700 : 400
              }}
              onClick={() => {
                setActiveTab(section.id);
                if (isMobile) setMobileFilterVisible(false);
              }}
            >
              {section.title}
            </Button>
          ))}
        </div>
      </div>

      {/* Tags */}
      <div>
        {!isMobile && <Title level={5} style={{ color: COLORS.text, marginBottom: 12, fontSize: 14, paddingLeft: 8 }}>
          <FilterFilled style={{ marginRight: 8 }} /> 标签
        </Title>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(78px, 1fr))', gap: 8 }}>
          {availableTags.map(tag => (
            <Tag.CheckableTag
              key={tag}
              checked={selectedTags.includes(tag)}
              onChange={checked => {
                if (checked) {
                  setSelectedTags([...selectedTags, tag]);
                } else {
                  setSelectedTags(selectedTags.filter(t => t !== tag));
                }
              }}
              style={{ 
                border: `1px solid ${selectedTags.includes(tag) ? COLORS.primary : COLORS.secondary}`, 
                borderRadius: 12,
                padding: '4px 2px',
                margin: 0,
                background: selectedTags.includes(tag) ? COLORS.primary : 'transparent',
                color: selectedTags.includes(tag) ? '#fff' : COLORS.textLight,
                width: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                textAlign: 'center'
              }}
            >
              <div style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag}</div>
            </Tag.CheckableTag>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <Drawer
        title={
          isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
              <div className="prompt-drawer-title-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <Space align="center" className="prompt-drawer-title-left">
                  <div style={{ 
                    width: 32, height: 32, borderRadius: 8, background: COLORS.primary, 
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' 
                  }}>
                    <AppstoreFilled />
                  </div>
                  <span className="prompt-drawer-title-text" style={{ fontWeight: 800, color: COLORS.text, fontSize: 18 }}>提示词广场</span>
                </Space>
                <Space size={8}>
                  <Button
                    icon={<SearchIcon color={mobileSearchVisible ? COLORS.primary : mobileInactiveIconColor} />}
                    shape="circle"
                    onClick={() => setMobileSearchVisible((prev) => !prev)}
                    className={`mobile-icon-btn circle-icon-btn${mobileSearchVisible ? ' is-active' : ''}`}
                  />
                  <Button
                    icon={<FilterFilled style={{ color: mobileFilterVisible ? COLORS.primary : mobileInactiveIconColor, fontSize: 18, transform: 'translateY(1px)' }} />}
                    shape="circle"
                    onClick={() => setMobileFilterVisible(true)}
                    className={`mobile-icon-btn circle-icon-btn${mobileFilterVisible ? ' is-active' : ''}`}
                  />
                </Space>
              </div>
              <div style={{
                height: mobileSearchVisible ? 46 : 0,
                opacity: mobileSearchVisible ? 1 : 0,
                marginTop: mobileSearchVisible ? 12 : 0,
                overflow: 'hidden',
                transition: 'all 0.3s ease',
                display: 'flex',
                alignItems: 'center',
                padding: '0 4px'
              }}>
                <Input 
                  size="large"
                  key={mobileSearchVisible ? 'visible' : 'hidden'}
                  autoFocus={mobileSearchVisible}
                  prefix={
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <SearchIcon color={COLORS.primary} />
                    </span>
                  }
                  placeholder="搜索提示词..." 
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="custom-search-input"
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          ) : (
            <div className="prompt-drawer-title-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <Space align="center" className="prompt-drawer-title-left">
                <div style={{ 
                  width: 32, height: 32, borderRadius: 8, background: COLORS.primary, 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' 
                }}>
                  <AppstoreFilled />
                </div>
                <span className="prompt-drawer-title-text" style={{ fontWeight: 800, color: COLORS.text, fontSize: 18 }}>提示词广场</span>
              </Space>
              <Space size={8}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Select
                    style={{ width: 180 }}
                    value={sourceUrl === DEFAULT_DATA_SOURCE ? DEFAULT_DATA_SOURCE : 'custom'}
                    onChange={(value) => {
                      if (value === 'custom') {
                        setSourceUrl('');
                      } else {
                        setSourceUrl(value);
                      }
                    }}
                    options={[
                      { label: 'nanobanana-website', value: DEFAULT_DATA_SOURCE },
                      { label: '自定义源', value: 'custom' }
                    ]}
                  />
                  <Input 
                    style={{ width: 240, borderRadius: 12 }} 
                    value={sourceUrl} 
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="数据源 URL"
                  />
                  <Button className="prompt-refresh-btn" shape="circle" icon={<ReloadOutlined spin={loading} />} onClick={fetchData} />
                </div>
              </Space>
            </div>
          )
        }
        placement={isMobile ? "bottom" : "top"}
        height={isMobile ? "90vh" : "95vh"}
        push={false}
        onClose={onClose}
        open={visible}
        styles={{
          body: {
            padding: 0,
            background: 'var(--c-bg)',
            backgroundImage: 'var(--moe-dot-bg-image)',
            backgroundSize: 'var(--moe-dot-bg-size)',
            backgroundPosition: 'var(--moe-dot-bg-position)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          },
          header: {
            background: 'rgba(255,255,255,0.9)',
            borderBottom: `1px solid ${COLORS.accent}`,
            backdropFilter: 'blur(10px)',
            transition: 'height 0.3s ease',
            alignItems: isMobile ? 'flex-start' : 'center'
          }
        }}
        width={isMobile ? "100%" : undefined}
      >
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Desktop Sidebar */}
          {!isMobile && (
            <div style={{ width: 260, flexShrink: 0, minHeight: 0, overflow: 'hidden' }}>
              {renderSidebar()}
            </div>
          )}

          {/* Main Content */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, padding: isMobile ? 16 : 32, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

            {loading ? (
              <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <Spin size="large" tip="少女祈祷中..." />
              </div>
            ) : filteredPrompts.length === 0 ? (
              <Empty 
                description="没有找到相关提示词~" 
                image={Empty.PRESENTED_IMAGE_SIMPLE} 
                style={{ marginTop: 60, color: COLORS.textLight }} 
              />
            ) : (
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))', 
                gap: isMobile ? 12 : 24 
              }}>
                {filteredPrompts.map(prompt => (
                  <div 
                    key={prompt.id}
                    style={{ 
                      background: '#fff', 
                      borderRadius: 16,
                      overflow: 'hidden',
                      boxShadow: '0 4px 12px rgba(255, 143, 171, 0.1)',
                      cursor: 'pointer',
                      border: `1px solid ${COLORS.accent}`,
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      transition: 'transform 0.2s',
                    }}
                    className="prompt-card-hover"
                    onClick={() => openPreview(prompt)}
                  >
                    <div style={{ position: 'relative', aspectRatio: '1/1', background: '#FAFAFA', overflow: 'hidden' }}>
                      {prompt.images && prompt.images.length > 0 ? (
                        <img 
                          src={prompt.images[0]} 
                          alt={prompt.title}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: COLORS.secondary }}>
                          <FileTextOutlined style={{ fontSize: 32 }} />
                        </div>
                      )}
                      
                      {/* Tags Overlay */}
                      <div style={{ 
                        position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', justifyContent: 'space-between'
                      }}>
                         <div style={{ 
                          background: 'rgba(255,255,255,0.9)', 
                          padding: '2px 8px', 
                          borderRadius: 10,
                          fontSize: 10,
                          fontWeight: 700,
                          color: COLORS.text,
                          backdropFilter: 'blur(4px)',
                          boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
                        }}>
                          {prompt.sectionTitle}
                        </div>
                        {isNewItem(prompt.id) && (
                          <div style={{ 
                            background: COLORS.new, color: '#fff',
                            padding: '2px 6px', borderRadius: 10,
                            fontSize: 10, fontWeight: 800,
                            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                          }}>
                            NEW
                          </div>
                        )}
                      </div>

                      {/* Favorite Button */}
                      <div 
                        style={{ 
                          position: 'absolute', bottom: 8, right: 8,
                          background: 'rgba(255,255,255,0.9)',
                          width: 28, height: 28, borderRadius: '50%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                        onClick={(e) => toggleFavorite(e, prompt.id)}
                      >
                        {favorites.includes(prompt.id) ? 
                          <StarFilled style={{ color: COLORS.gold, fontSize: 16 }} /> : 
                          <StarOutlined style={{ color: COLORS.textLight, fontSize: 16 }} />
                        }
                      </div>
                    </div>

                    <div style={{ padding: '8px 12px 10px 12px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <Title level={5} style={{ margin: '0 0 6px 0', color: COLORS.text, fontSize: 18, fontWeight: 700, lineHeight: 1.3 }} ellipsis={{ rows: 1 }}>
                        {prompt.title}
                      </Title>

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                        {prompt.tags?.slice(0, 3).map(tag => (
                          <Tag key={tag} style={{ margin: 0, fontSize: 12, padding: '2px 8px', border: 'none', background: '#F5F5F5', color: COLORS.textLight }}>#{tag}</Tag>
                        ))}
                      </div>
                      
                      <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto', paddingTop: 6 }}>
                        <Avatar size={20} icon={<UserOutlined />} style={{ backgroundColor: COLORS.secondary }} />
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 6, color: COLORS.textLight }} ellipsis>
                          {prompt.contributor || '匿名'}
                        </Text>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Mobile Filter Drawer */}
        <Drawer
          title="筛选提示词"
          placement="bottom"
          height="70vh"
          onClose={() => setMobileFilterVisible(false)}
          open={mobileFilterVisible && isMobile}
          styles={{ body: { padding: 0 } }}
          push={false}
        >
          {renderSidebar()}
        </Drawer>
      </Drawer>

      {/* Detail Modal */}
      <Modal
        open={!!previewPrompt}
        onCancel={() => setPreviewPrompt(null)}
        footer={null}
        width={isMobile ? '100%' : 'min(1000px, 90vw)'}
        centered
        destroyOnClose
        style={isMobile ? { maxWidth: '100vw', margin: 0, padding: 0, top: 0 } : {}}
        styles={{ 
          content: { 
            padding: 0, 
            borderRadius: isMobile ? 0 : 20, 
            overflow: 'hidden',
            height: isMobile ? '100vh' : 'auto',
            maxHeight: isMobile ? '100vh' : '90vh',
            display: 'flex',
            flexDirection: 'column'
          },
          body: { 
            height: isMobile ? '100%' : 'auto',
            padding: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            flex: 1
          }
        }}
        closeIcon={
          <div style={{ 
            background: 'rgba(0,0,0,0.1)', borderRadius: '50%', width: 30, height: 30, 
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' 
          }}><div style={{marginTop: -2}}>×</div></div>
        }
      >
        {previewPrompt && currentPreviewData && (
          <div style={{ 
            display: 'flex', 
            flexDirection: (isMobile || imageAspectRatio === 'landscape') ? 'column' : 'row',
            height: isMobile ? '100%' : '80vh',
            maxHeight: isMobile ? '100%' : 800,
            background: '#fff'
          }}>
            {/* Image Area */}
            <div style={{ 
              flex: (isMobile || imageAspectRatio === 'landscape') ? '0 0 auto' : '1.5',
              background: '#000',
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
              height: isMobile ? '40vh' : (imageAspectRatio === 'landscape' ? '45vh' : '100%'),
              width: (isMobile || imageAspectRatio === 'landscape') ? '100%' : '55%'
            }}>
              {currentPreviewData.images.length > 0 ? (
                <>
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Image
                      src={currentPreviewData.images[previewImageIndex]}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      width="100%"
                      height="100%"
                      preview={isMobile ? { maskClassName: 'mobile-hidden-mask' } : undefined}
                    />
                  </div>
                  {/* Image Navigation */}
                  {currentPreviewData.images.length > 1 && (
                    <>
                      <div 
                        style={{ 
                          position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)',
                          width: 40, height: 40, borderRadius: '50%',
                          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', zIndex: 10, color: '#fff'
                        }}
                        onClick={() => setPreviewImageIndex(prev => (prev - 1 + currentPreviewData.images.length) % currentPreviewData.images.length)}
                      >
                        <LeftOutlined style={{ fontSize: 20 }} />
                      </div>
                      <div 
                        style={{ 
                          position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)',
                          width: 40, height: 40, borderRadius: '50%',
                          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', zIndex: 10, color: '#fff'
                        }}
                        onClick={() => setPreviewImageIndex(prev => (prev + 1) % currentPreviewData.images.length)}
                      >
                        <RightOutlined style={{ fontSize: 20 }} />
                      </div>
                      <div style={{ 
                        position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
                        background: 'rgba(0,0,0,0.5)', borderRadius: 12, padding: '2px 8px', color: '#fff', fontSize: 12,
                        zIndex: 10
                      }}>
                        {previewImageIndex + 1} / {currentPreviewData.images.length}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <Empty description="暂无预览图" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>

            {/* Info Area */}
            <div style={{ 
              flex: 1, 
              display: 'flex', 
              flexDirection: 'column',
              padding: isMobile ? 20 : 32,
              overflowY: 'auto',
              background: COLORS.bg
            }}>
              {/* Header */}
              <div style={{ marginBottom: 20 }}>
                <Space style={{ marginBottom: 8 }} wrap>
                  <Tag color="volcano" style={{ borderRadius: 8 }}>{previewPrompt.sectionTitle}</Tag>
                  {favorites.includes(previewPrompt.id) && <Tag color="gold" icon={<StarFilled />} style={{ borderRadius: 8 }}>已收藏</Tag>}
                  {isNewItem(previewPrompt.id) && <Tag color={COLORS.new} style={{ borderRadius: 8 }}>NEW</Tag>}
                </Space>
                <Title level={isMobile ? 4 : 3} style={{ margin: 0, color: COLORS.text }}>{previewPrompt.title}</Title>
                <Space style={{ marginTop: 8 }}>
                  <Avatar size="small" icon={<UserOutlined />} style={{ backgroundColor: COLORS.secondary }} />
                  <Text type="secondary">{currentPreviewData.contributor || '匿名贡献者'}</Text>
                </Space>
              </div>

              {/* Variants Tabs */}
              {previewPrompt.similar && previewPrompt.similar.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Tabs 
                    activeKey={activeVariantIndex.toString()}
                    onChange={(k) => setActiveVariantIndex(parseInt(k))}
                    type="card"
                    size="small"
                    items={[
                      { label: '主提示词', key: '0' },
                      ...previewPrompt.similar.map((_, i) => ({ label: `变体 ${i + 1}`, key: (i + 1).toString() }))
                    ]}
                  />
                </div>
              )}

              {/* Content Box */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ 
                  background: '#fff', 
                  padding: 16, 
                  borderRadius: 16, 
                  border: `1px solid ${COLORS.accent}`,
                  boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)',
                  flex: 1,
                  maxHeight: isMobile ? 200 : 300,
                  overflowY: 'auto'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}><FileTextOutlined /> 提示词内容</Text>
                    <Tooltip title="复制内容">
                      <Button 
                        type="text" 
                        size="small" 
                        icon={<CopyOutlined />} 
                        onClick={() => {
                          navigator.clipboard.writeText(currentPreviewData.content);
                          message.success('已复制到剪贴板');
                        }}
                      />
                    </Tooltip>
                  </div>
                  <Text style={{ fontSize: 14, fontFamily: 'monospace', color: COLORS.text }}>
                    {currentPreviewData.content}
                  </Text>
                </div>

                {/* Tags */}
                <div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {previewPrompt.tags?.map(tag => (
                      <Tag key={tag} style={{ 
                        padding: '4px 10px', fontSize: 12, borderRadius: 10, 
                        border: 'none', background: '#fff', color: COLORS.textLight 
                      }}>#{tag}</Tag>
                    ))}
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              <div style={{ display: 'flex', gap: 12, marginTop: 24, paddingTop: 16, borderTop: `1px solid ${COLORS.accent}` }}>
                <Button 
                  type="primary" 
                  size="large" 
                  block 
                  icon={<PlusCircleFilled />}
                  onClick={() => handleUsePrompt(currentPreviewData.content)}
                  style={{ 
                    height: 44, fontSize: 16, borderRadius: 22, 
                    background: `linear-gradient(45deg, ${COLORS.primary}, #FFB2C1)`,
                    border: 'none',
                    boxShadow: '0 4px 12px rgba(255, 143, 171, 0.4)'
                  }}
                >
                  使用此提示词
                </Button>
                <Button 
                  size="large" 
                  icon={favorites.includes(previewPrompt.id) ? <StarFilled style={{ color: COLORS.gold }} /> : <StarOutlined />}
                  onClick={(e) => toggleFavorite(e, previewPrompt.id)}
                  style={{ width: 44, height: 44, borderRadius: '50%', border: `1px solid ${COLORS.secondary}` }}
                />
              </div>
            </div>
          </div>
        )}
      </Modal>
      
      <style>{`
        .prompt-card-hover:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 20px rgba(255, 143, 171, 0.25) !important;
        }
        /* Custom Scrollbar */
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: #FFC2D1;
          border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #FF8FAB;
        }
        .custom-search-input.ant-input-affix-wrapper {
          border-radius: 50px;
          border: 1px solid #FFE5EC;
          background-color: #fff;
          transition: all 0.3s ease;
          padding: 4px 12px;
          padding-left: 10px;
          height: 38px;
          align-items: center;
        }

        .mobile-icon-btn.ant-btn {
          border: 2px solid #F0F0F0 !important;
          background: #fff !important;
        }

        .mobile-icon-btn.ant-btn.is-active {
          border-color: ${COLORS.primary} !important;
        }

        .custom-search-input.ant-input-affix-wrapper .ant-input-prefix {
          display: flex;
          align-items: center;
        }

        .custom-search-input.ant-input-affix-wrapper .ant-input-prefix svg {
          display: block;
          transform: translateY(-1px);
        }
        
        /* 强制覆盖 Ant Design 默认样式以避免“双重框”感 */
        .custom-search-input.ant-input-affix-wrapper > input.ant-input {
          border: none !important;
          box-shadow: none !important;
          background: transparent !important;
          padding-left: 8px; /* 增加一点 input 的 padding 以控制光标位置，但不要太远 */
          font-size: 14px;
        }

        .custom-search-input.ant-input-affix-wrapper .ant-input-prefix {
          margin-inline-end: 0;
        }
        
        .custom-search-input.ant-input-affix-wrapper::before,
        .custom-search-input.ant-input-affix-wrapper::after {
          display: none;
        }
        
        .custom-search-input.ant-input-affix-wrapper:hover {
          border-color: #FFC2D1;
        }
        
        .custom-search-input.ant-input-affix-wrapper-focused,
        .custom-search-input.ant-input-affix-wrapper:focus-within {
          border-color: #FF9EB5;
          box-shadow: 0 0 0 2px rgba(255, 158, 181, 0.2);
        }

        .prompt-drawer-title-row {
          min-height: 40px;
        }

        .prompt-drawer-title-left {
          display: inline-flex;
          align-items: center;
          height: 40px;
        }

        .prompt-drawer-title-text {
          display: inline-flex;
          align-items: center;
          height: 32px;
          line-height: 1;
        }

        .mobile-hidden-mask {
          opacity: 0 !important;
          background: transparent !important;
        }
      `}</style>
    </>
  );
};

export default PromptDrawer;
