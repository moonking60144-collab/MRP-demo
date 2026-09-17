import type {
  StagingForecast,
  StagingInventory,
  StagingOrder,
  StagingPartVersion,
  StagingProductionPlan,
  StagingPurchaseOrder,
  StagingWorkOrder,
  StagingWorkOrderBom,
} from '@prisma/client';
import prisma from '../db';
import {
  normalizeOrderDemandContractVersion,
  type OrderDemandContractVersion,
} from './order-demand-contract';

export interface RunCalculationInputs {
  runDate: Date;
  orderDemandContractVersion: OrderDemandContractVersion;
  partVersionRows: readonly StagingPartVersion[];
  inventoryRows: readonly StagingInventory[];
  orderRows: readonly StagingOrder[];
  forecastRows: readonly StagingForecast[];
  workOrderRows: readonly StagingWorkOrder[];
  workOrderBomRows: readonly StagingWorkOrderBom[];
  productionPlanRows: readonly StagingProductionPlan[];
  purchaseOrderRows: readonly StagingPurchaseOrder[];
}

type InventoryRowsLoader = (runId: number) => Promise<readonly StagingInventory[]>;

const loadInventoryRowsFromDb: InventoryRowsLoader = (runId) =>
  prisma.stagingInventory.findMany({ where: { mrpRunId: runId } });

export async function getRunInventoryRows(
  runId: number,
  inputs?: RunCalculationInputs,
  loader: InventoryRowsLoader = loadInventoryRowsFromDb,
): Promise<readonly StagingInventory[]> {
  return inputs?.inventoryRows ?? loader(runId);
}

export async function loadRunCalculationInputs(runId: number): Promise<RunCalculationInputs> {
  const run = await prisma.mrpRun.findUnique({
    where: { id: runId },
    select: { runDate: true, orderDemandContractVersion: true },
  });
  if (!run) throw new Error(`Cannot load calculation inputs: run #${runId} not found`);

  const [
    partVersionRows,
    inventoryRows,
    orderRows,
    forecastRows,
    workOrderRows,
    workOrderBomRows,
    productionPlanRows,
    purchaseOrderRows,
  ] = await Promise.all([
    prisma.stagingPartVersion.findMany({ where: { mrpRunId: runId } }),
    getRunInventoryRows(runId),
    prisma.stagingOrder.findMany({ where: { mrpRunId: runId } }),
    prisma.stagingForecast.findMany({ where: { mrpRunId: runId } }),
    prisma.stagingWorkOrder.findMany({ where: { mrpRunId: runId } }),
    prisma.stagingWorkOrderBom.findMany({ where: { mrpRunId: runId } }),
    prisma.stagingProductionPlan.findMany({ where: { mrpRunId: runId } }),
    prisma.stagingPurchaseOrder.findMany({ where: { mrpRunId: runId } }),
  ]);

  return {
    runDate: new Date(run.runDate),
    orderDemandContractVersion: normalizeOrderDemandContractVersion(
      run.orderDemandContractVersion,
    ),
    partVersionRows,
    inventoryRows,
    orderRows,
    forecastRows,
    workOrderRows,
    workOrderBomRows,
    productionPlanRows,
    purchaseOrderRows,
  };
}
