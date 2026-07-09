// ============================================================
// 格式化工具函数
// ============================================================

export function formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatNumber(num: number): string {
    return num?.toLocaleString() || '0';
}

export function formatRate(rate: number): string {
    if (rate === undefined || rate === null) return '0.0%';
    return (rate * 100).toFixed(1) + '%';
}

export function formatTime(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

export function getFileType(filename: string): string {
    const ext = filename?.split('.').pop()?.toLowerCase();
    const typeMap: Record<string, string> = {
        'pdf': 'PDF', 'doc': 'DOC', 'docx': 'DOC', 'txt': 'TXT',
        'jpg': 'IMG', 'png': 'IMG', 'gif': 'IMG', 'svg': 'IMG',
        'mp4': 'VID', 'mp3': 'AUD', 'zip': 'ZIP', 'rar': 'ZIP'
    };
    return typeMap[ext || ''] || 'FILE';
}

export function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}
