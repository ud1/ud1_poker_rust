
use std::net::SocketAddr;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use warp::{http::StatusCode, http::Response, http::header::CONTENT_TYPE, ws::Message, Filter, Rejection, Reply, ws::WebSocket};
use std::str::FromStr;
use futures_util::{StreamExt, FutureExt};
use tokio_stream::wrappers::UnboundedReceiverStream;
use uuid::Uuid;
use configparser::ini::Ini;
use std::fs;
use chrono::{DateTime, Local};

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Hash, Clone)]
struct UserUuid(String);

impl FromStr for UserUuid {
    type Err = core::convert::Infallible;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(UserUuid(String::from(s)))
    }
}

#[derive(Debug, PartialEq, Eq, Hash, Clone)]
struct RoomUuid(String);

impl FromStr for RoomUuid {
    type Err = core::convert::Infallible;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(RoomUuid(String::from(s)))
    }
}

#[derive(Debug, PartialEq, Eq, Hash, Clone, Serialize, Deserialize)]
struct StoryUuid(String);

impl FromStr for StoryUuid {
    type Err = core::convert::Infallible;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(StoryUuid(String::from(s)))
    }
}

struct User {
    pub user_uuid: UserUuid,
    pub pub_user_uuid: UserUuid,
    pub user_name: String,
    pub role: UserRole,
    pub is_active: bool,
    pub sender: Option<mpsc::UnboundedSender<std::result::Result<Message, warp::Error>>>,
}

fn new_uuid() -> String {
    Uuid::new_v4().to_hyphenated().to_string()
}

impl User {
    fn new(user_uuid: &UserUuid) -> User {
        User {
            user_uuid: user_uuid.clone(),
            pub_user_uuid: UserUuid(new_uuid()),
            user_name: String::new(),
            role: UserRole::Voter,
            is_active: true,
            sender: None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
enum StoryState {
    Voting,
    Finished,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
enum Vote {
    Value(f64),
    Coffee,
    Question,
    Hidden
}

struct Story {
    pub story_uuid: StoryUuid,
    pub story_url: String,
    pub story_description: String,
    pub state: StoryState,
    pub votes: HashMap<UserUuid, Vote>,
}

struct Room {
    pub users: HashMap<UserUuid, User>,
    pub stories: Vec<Story>,
    pub owner: Option<UserUuid>,
    pub active_story: Option<StoryUuid>,
    pub creation_time: DateTime<Local>,
}

impl Room {
    fn new() -> Room {
        Room {
            users: HashMap::new(),
            stories: Vec::new(),
            owner: None,
            active_story: None,
            creation_time: Local::now()
        }
    }
}

type WsResult<T> = std::result::Result<T, Rejection>;
type RoomsRef = Arc<RwLock<HashMap<RoomUuid, Room>>>;
type ConfigRef = Arc<Config>;

async fn health_handler() -> WsResult<impl Reply> {
    Ok(StatusCode::OK)
}

#[derive(Serialize, Deserialize, Debug)]
struct UserMessage {
    pub user_name: String,
    pub role: UserRole,
}

#[derive(Serialize, Deserialize, Debug)]
struct StoryItem {
    pub story_url: String,
    pub story_description: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct AddStoriesMessage {
    pub stories: Vec<StoryItem>
}

#[derive(Serialize, Deserialize, Debug)]
struct RemoveStoryMessage {
    pub story_uuid: StoryUuid
}

#[derive(Serialize, Deserialize, Debug)]
struct VoteMessage {
    pub story_uuid: StoryUuid,
    pub vote: Vote
}

#[derive(Serialize, Deserialize, Debug)]
struct StoryUpdateMessage {
    pub story_uuid: StoryUuid,
    pub story: StoryItem,
    pub state: StoryState,
    pub votes: HashMap<UserUuid, Vote>
}

#[derive(Serialize, Deserialize, Debug)]
struct StoriesUpdateMessage {
    pub stories: Vec<StoryUpdateMessage>,
    pub active_story: Option<StoryUuid>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
enum UserRole {
    Voter, Watcher
}

#[derive(Serialize, Deserialize, Debug)]
struct UserUpdateMessage {
    pub pub_user_uuid: UserUuid,
    pub user_name: String,
    pub role: UserRole,
    pub is_this: bool,
    pub is_active: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct UsersUpdateMessage {
    pub users: Vec<UserUpdateMessage>
}

#[derive(Serialize, Deserialize, Debug)]
struct FinishVotingMessage {
    pub story_uuid: StoryUuid
}

#[derive(Serialize, Deserialize, Debug)]
struct SetActiveStoryMessage {
    pub story_uuid: StoryUuid
}

#[derive(Serialize, Deserialize, Debug)]
struct Config {
    vote_options: Vec<f64>
}

#[derive(Serialize, Deserialize, Debug)]
struct RoomConfigMessage {
    vote_options: Vec<f64>,
    owner: UserUuid,
    me: UserUuid,
    room_creation_time: String
}

fn send_users_update_message(room: &mut Room) {
    for (_, user) in room.users.iter() {
        if let Some(sender) = &user.sender {
            let message = UsersUpdateMessage {
                users: room.users.iter().map(|(_, u)| {
                    UserUpdateMessage {
                        pub_user_uuid: u.pub_user_uuid.clone(),
                        user_name: u.user_name.clone(),
                        role: u.role.clone(),
                        is_this: user.user_uuid == u.user_uuid,
                        is_active: u.is_active
                    }
                }).collect()
            };
            
            if sender.send(Ok(Message::text(format!("users {}", serde_json::to_string(&message).unwrap())))).is_err() {
                eprintln!("Send users message error");
            }
        }
    }
}

fn compute_votes(story: &Story, users: &HashMap<UserUuid, User>, current_pub_user_id: &UserUuid) -> HashMap<UserUuid, Vote> {
    let mut finished = story.state == StoryState::Finished;
    if !finished {
        finished = match users.iter().find(|(_, u)| u.role == UserRole::Voter && u.is_active && !story.votes.contains_key(&u.pub_user_uuid)) {
            Some(_) => false,
            None => true
        }
    }

    if finished {
        story.votes.clone()
    }
    else {
        story.votes.iter().map(|(k, v)| (k.clone(), if k == current_pub_user_id {v.clone()} else {Vote::Hidden})).collect()
    }
}

fn send_stories_update_message(room: &mut Room) {
    for (_, user) in room.users.iter() {
        if let Some(sender) = &user.sender {
            let message = StoriesUpdateMessage {
                stories: room.stories.iter().map(|s| {
                    StoryUpdateMessage {
                        story_uuid: s.story_uuid.clone(),
                        story: StoryItem {
                            story_url: s.story_url.clone(),
                            story_description: s.story_description.clone()
                        },
                        state: s.state.clone(),
                        votes: compute_votes(s, &room.users, &user.pub_user_uuid)
                    }
                }).collect(),
                active_story: room.active_story.clone()
            };
            if sender.send(Ok(Message::text(format!("stories {}", serde_json::to_string(&message).unwrap())))).is_err() {
                eprintln!("Send stories message error");
            }
        }
    }
}

fn send_config_message(user: &mut User, config_message: ConfigRef, owner: &UserUuid, room_creation_time: &DateTime<Local>) {
    if let Some(sender) = &user.sender {
        let room_config = RoomConfigMessage {
            vote_options: config_message.vote_options.clone(),
            owner: owner.clone(),
            me: user.pub_user_uuid.clone(),
            room_creation_time: room_creation_time.format("%Y-%m-%d %H:%M:%S").to_string()
        };
        if sender.send(Ok(Message::text(format!("config {}", serde_json::to_string(&room_config).unwrap())))).is_err() {
            eprintln!("Send config message error");
        }
    }
}

async fn client_msg(user_id: &UserUuid, pub_user_uuid: &UserUuid, room_id: &RoomUuid, msg: Message, rooms: &RoomsRef) {
    //println!("received message from {:?}: {:?}", room_id, msg);
    let message = match msg.to_str() {
        Ok(v) => v,
        Err(_) => return,
    };

    if message == "ping" || message == "ping\n" {
        return;
    }

    if let Some(room) = rooms.write().await.get_mut(&room_id) {
        if message.starts_with("user ") {
            if let Ok(message) = serde_json::from_str::<UserMessage>(&message["user ".len()..]) {
                if let Some(user) = room.users.get_mut(user_id) {
                    user.user_name = message.user_name;
                    user.role = message.role;
                }

                send_users_update_message(room);
            }
            else {
                eprintln!("Parse user error {}", message);
            }
        }
        else if message.starts_with("stories ") {
            if let Ok(message) = serde_json::from_str::<AddStoriesMessage>(&message["stories ".len()..]) {
                for story in message.stories {
                    room.stories.push(Story {
                        story_uuid: StoryUuid(new_uuid()),
                        story_url: story.story_url,
                        story_description: story.story_description,
                        state: StoryState::Voting,
                        votes: HashMap::new()
                    });
                }

                send_stories_update_message(room);
            }
            else {
                eprintln!("Parse stories error {}", message);
            }
        }
        else if message.starts_with("remove_story ") {
            if room.owner.as_ref() != Some(pub_user_uuid) {
                eprintln!("Not an owner to remove_story");
                return;
            }

            if let Ok(message) = serde_json::from_str::<RemoveStoryMessage>(&message["remove_story ".len()..]) {
                let old_len = room.stories.len();
                room.stories.retain(|s| s.story_uuid != message.story_uuid);
                if room.stories.len() != old_len {
                    send_stories_update_message(room);
                }
            }
            else {
                eprintln!("Parse remove_story error {}", message);
            }
        }
        else if message.starts_with("vote ") {
            if let Ok(message) = serde_json::from_str::<VoteMessage>(&message["vote ".len()..]) {
                let story = room.stories.iter_mut().find(|s| s.story_uuid == message.story_uuid);
                let user = room.users.get(user_id);
                if let Some(story) = story {
                    if story.state == StoryState::Voting {
                        if let Some(user) = user {
                            story.votes.insert(user.pub_user_uuid.clone(), message.vote);
                            send_stories_update_message(room);
                        }
                    }
                    else {
                        eprintln!("Story already finished, voting ignored")
                    }
                }
            }
            else {
                eprintln!("Parse vote error {}", message);
            }
        }
        else if message.starts_with("finish ") {
            if room.owner.as_ref() != Some(pub_user_uuid) {
                eprintln!("Not an owner to finish");
                return;
            }

            if let Ok(message) = serde_json::from_str::<FinishVotingMessage>(&message["finish ".len()..]) {
                let story = room.stories.iter_mut().find(|s| s.story_uuid == message.story_uuid);
                if let Some(story) = story {
                    story.state = StoryState::Finished;
                    send_stories_update_message(room);
                }
            }
            else {
                eprintln!("Parse finish error {}", message);
            }
        }
        else if message.starts_with("active_story ") {
            if room.owner.as_ref() != Some(pub_user_uuid) {
                eprintln!("Not an owner to active_story {}", message);
                return;
            }

            if let Ok(message) = serde_json::from_str::<SetActiveStoryMessage>(&message["active_story ".len()..]) {
                room.active_story = Some(message.story_uuid);
                send_stories_update_message(room);
            }
            else {
                eprintln!("Parse active_story error {}", message);
            }
        }
        else {
            eprintln!("Unsupported message {}", message);
        }
    }
}

async fn client_connection(ws: WebSocket, user_id: UserUuid, room_id: RoomUuid, rooms: RoomsRef, config_message: ConfigRef) {
    let mut locked = rooms.write().await;
    let room = locked.entry(room_id.clone()).or_insert_with(|| Room::new());

    let (user_ws_tx, mut user_ws_rx) = ws.split();
    let (tx, rx) = mpsc::unbounded_channel();
    let rx = UnboundedReceiverStream::new(rx);
    
    tokio::task::spawn(rx.forward(user_ws_tx).map(|result| {
        if let Err(e) = result {
            eprintln!("error sending websocket msg: {}", e);
        }
    }));

    let user = room.users.entry(user_id.clone()).or_insert_with(|| User::new(&user_id));
    user.sender = Some(tx);
    user.is_active = true;
    let pub_user_uuid = user.pub_user_uuid.clone();

    let owner = match &room.owner {
        None => {
            room.owner = Some(pub_user_uuid.clone());
            pub_user_uuid.clone()
        }
        Some(owner) => owner.clone()
    };
    println!("{:?} connected", user_id);

    let creation_time = room.creation_time;
    send_config_message(user, config_message, &owner, &creation_time);
    send_users_update_message(room);
    send_stories_update_message(room);

    drop(locked); // release lock

    while let Some(result) = user_ws_rx.next().await {
        let msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("error receiving ws message for id: {:?}): {}", user_id, e);
                break;
            }
        };
        println!("{:?} connected", user_id);
        client_msg(&user_id, &pub_user_uuid, &room_id, msg, &rooms).await;
    }

    if let Some(room) = rooms.write().await.get_mut(&room_id) {
        if let Some(user) = room.users.get_mut(&user_id) {
            user.is_active = false;
            user.sender = None;
        }

        send_users_update_message(room);
    }
    println!("{:?} disconnected", user_id);
}

async fn ws_handler(ws: warp::ws::Ws, user_id: UserUuid, room_id: RoomUuid, rooms: RoomsRef, config_message: ConfigRef) -> WsResult<impl Reply> {
    Ok(ws.on_upgrade(move |socket| client_connection(socket, user_id, room_id, rooms, config_message)))
}

#[tokio::main]
async fn main() {
    let config_str = fs::read_to_string("config.ini").unwrap_or(String::from(""));

    let mut config = Ini::new();
    if config.read(config_str).is_err() {
        eprintln!("Read config.ini error");
    }
    let addr = config.get("net", "addr").unwrap_or(String::from("0.0.0.0:15000")).parse::<SocketAddr>().unwrap();
    println!("Listen {}", addr);

    let config_message = Arc::new(Config {
        vote_options: config.get("cards", "cards").unwrap_or(String::from("0 0.5 1 2 3 5 8 10 15 20 40 60"))
            .split_whitespace()
            .map(|s| s.parse().expect("parse error"))
            .collect()
    });

    let rooms: RoomsRef = Arc::new(RwLock::new(HashMap::new()));

    let health_route = warp::path!("health").and_then(health_handler);
    let main_route = warp::path!().map(|| warp::reply::html(include_str!("../web/index.html")));
    let bootstrap_css_route = warp::path!("style" / "bootstrap.min.css").map(|| Response::builder()
             .header(CONTENT_TYPE, "text/css")
             .body(include_str!("../web/node_modules/bootstrap/dist/css/bootstrap.min.css")));

    let bundle_js_route = warp::path!("js" / "bundle.min.js").map(|| Response::builder()
             .header(CONTENT_TYPE, "application/javascript")
             .body(include_str!("../web/js/bundle.min.js")));

    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(warp::path::param())
        .and(warp::path::param())
        .and(with_clients(rooms.clone()))
        .and(with_config(config_message))
        .and_then(ws_handler);

    let routes = health_route
        .or(main_route)
        .or(bootstrap_css_route)
        .or(bundle_js_route)
        .or(ws_route)
        .with(warp::cors().allow_any_origin());

    warp::serve(routes).run(addr).await;
}

fn with_clients(rooms: RoomsRef) -> impl Filter<Extract = (RoomsRef,), Error = Infallible> + Clone {
    warp::any().map(move || rooms.clone())
}

fn with_config(config_message: ConfigRef) -> impl Filter<Extract = (ConfigRef,), Error = Infallible> + Clone {
    warp::any().map(move || config_message.clone())
}
