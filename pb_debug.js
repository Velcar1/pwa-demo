
import PocketBase from 'pocketbase';

const PB_URL = 'https://slots-institution-compact-gamma.trycloudflare.com/';
const pb = new PocketBase(PB_URL);
const groupId = '1qoqy5rp5ciwaq3';

async function test() {
    console.log("--- PocketBase PWA Fetch Test ---");
    console.log("Target URL:", PB_URL);
    console.log("Target Group ID:", groupId);

    try {
        console.log("1. Checking connection to pwa_config (fetching ALL)...");
        const configs = await pb.collection('pwa_config').getFullList({
             sort: '-created'
        });
        console.log(`Found ${configs.length} total config records in collection.`);
        configs.forEach((c, i) => {
            console.log(`Record ${i+1}: ID=${c.id}, Type=${c.content_type}, IsSchedule=${c.is_schedule}`);
        });

        if (configs.length === 0) {
            console.log("WARNING: Zero records found. Check if the group ID is correct and API Rules allow public List/View.");
        }

        console.log("2. Checking device group record...");
        try {
            const group = await pb.collection('device_groups').getOne(groupId);
            console.log("Group name:", group.name);
        } catch (e) {
            console.log("Could not fetch group details (maybe no public view permission on device_groups?).");
        }

    } catch (err) {
        console.error("CRITICAL ERROR during test:", err);
    }
}

test();
