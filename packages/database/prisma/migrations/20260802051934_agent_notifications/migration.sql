-- DropForeignKey
ALTER TABLE "chat_room_tids" DROP CONSTRAINT "chat_room_tids_room_id_fkey";

-- DropForeignKey
ALTER TABLE "chat_room_tids" DROP CONSTRAINT "chat_room_tids_tid_id_fkey";

-- DropIndex
DROP INDEX "pos_devices_warehouse_id_idx";

-- AlterTable
ALTER TABLE "status_options" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tid_sell_fees" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "agent_notifications" (
    "id" SERIAL NOT NULL,
    "recipient_agent_id" INTEGER NOT NULL,
    "actor_agent_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_notifications_recipient_agent_id_read_at_idx" ON "agent_notifications"("recipient_agent_id", "read_at");
