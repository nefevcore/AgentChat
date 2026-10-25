<script setup lang="ts">
// ============================================================
// client/CreateGroupHost.vue —— group 域 overlay 席位宿主
//（M28 P1：原 layout AppFrame 内联 SlotOutletItem 内容迁入——
// 绑线经 ctx.groups 服务面直连，DOM 结构不变〔D23-A 零包裹纪律〕）
// ============================================================
import CreateGroupDialog from './CreateGroupDialog.vue';
import { useClientContext } from 'ac-client-runtime';

const groupSvc = useClientContext()?.groups;
</script>

<template>
  <!-- 创建群组对话框（域服务缺位 = 行卸载后贡献一并消失，不渲染） -->
  <CreateGroupDialog
    v-if="groupSvc?.showCreateGroup.value"
    @close="groupSvc?.closeCreateGroup()"
    @created="(id: string) => groupSvc?.onGroupCreated(id)"
  />
</template>
